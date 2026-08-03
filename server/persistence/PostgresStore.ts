import { Pool, type PoolClient } from 'pg';

import type {
  CreateGuestSessionInput,
  MatchHistoryItem,
  MatchRecord,
  PersistenceStore,
  RotateSessionInput,
  StoredPlayer,
} from './types';

function rowPlayer(row: {
  id: string;
  display_name: string;
  created_at: Date;
}): StoredPlayer {
  return {
    id: row.id,
    displayName: row.display_name,
    createdAt: row.created_at.getTime(),
  };
}

export class PostgresStore implements PersistenceStore {
  readonly available = true;
  private readonly pool: Pool;

  constructor(connectionString: string) {
    this.pool = new Pool({
      connectionString,
      max: 5,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
    });
  }

  async initialize(): Promise<void> {
    await this.transaction(async (client) => {
      await client.query(`
        SELECT pg_advisory_xact_lock(684325390174);
        CREATE TABLE IF NOT EXISTS schema_migrations (
          id varchar(80) PRIMARY KEY,
          applied_at timestamptz NOT NULL DEFAULT now()
        );
      `);
      const applied = await client.query(
        'SELECT 1 FROM schema_migrations WHERE id = $1',
        ['001_identity_and_match_history'],
      );
      if (applied.rowCount === 1) return;
      await client.query(`
        CREATE TABLE players (
        id uuid PRIMARY KEY,
        display_name varchar(24) NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        last_seen_at timestamptz NOT NULL DEFAULT now()
      );
        CREATE TABLE player_sessions (
        id uuid PRIMARY KEY,
        player_id uuid NOT NULL REFERENCES players(id) ON DELETE CASCADE,
        refresh_token_hash char(64) NOT NULL UNIQUE,
        created_at timestamptz NOT NULL DEFAULT now(),
        expires_at timestamptz NOT NULL,
        revoked_at timestamptz
      );
        CREATE INDEX player_sessions_player_idx
        ON player_sessions(player_id);
        CREATE TABLE matches (
        id varchar(160) PRIMARY KEY,
        room_id varchar(96) NOT NULL,
        started_at timestamptz NOT NULL,
        finished_at timestamptz NOT NULL,
        difficulty varchar(16) NOT NULL,
        total_rounds smallint NOT NULL,
        mode_order jsonb NOT NULL,
        winner_player_id uuid,
        forfeited_player_id uuid,
        result jsonb NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      );
        CREATE TABLE match_players (
        match_id varchar(160) NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
        player_id uuid NOT NULL REFERENCES players(id) ON DELETE CASCADE,
        display_name varchar(24) NOT NULL,
        score integer NOT NULL,
        PRIMARY KEY (match_id, player_id)
      );
        CREATE INDEX match_players_player_idx
        ON match_players(player_id, match_id);
      `);
      await client.query(
        'INSERT INTO schema_migrations (id) VALUES ($1)',
        ['001_identity_and_match_history'],
      );
    });
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async createGuestSession(input: CreateGuestSessionInput): Promise<StoredPlayer> {
    return this.transaction(async (client) => {
      const player = await client.query(`
        INSERT INTO players (id, display_name)
        VALUES ($1, $2)
        RETURNING id, display_name, created_at
      `, [input.playerId, input.displayName]);
      await client.query(`
        INSERT INTO player_sessions (id, player_id, refresh_token_hash, expires_at)
        VALUES ($1, $2, $3, to_timestamp($4 / 1000.0))
      `, [
        input.sessionId,
        input.playerId,
        input.refreshTokenHash,
        input.refreshTokenExpiresAt,
      ]);
      return rowPlayer(player.rows[0]);
    });
  }

  async rotateSession(input: RotateSessionInput): Promise<{
    player: StoredPlayer;
    sessionId: string;
  } | null> {
    return this.transaction(async (client) => {
      const result = await client.query(`
        UPDATE player_sessions AS session
        SET refresh_token_hash = $2,
            expires_at = to_timestamp($3 / 1000.0)
        FROM players AS player
        WHERE session.refresh_token_hash = $1
          AND session.player_id = player.id
          AND session.revoked_at IS NULL
          AND session.expires_at > to_timestamp($4 / 1000.0)
        RETURNING
          session.id AS session_id,
          player.id,
          player.display_name,
          player.created_at
      `, [
        input.currentRefreshTokenHash,
        input.nextRefreshTokenHash,
        input.nextRefreshTokenExpiresAt,
        input.now,
      ]);
      if (result.rowCount !== 1) return null;
      return {
        player: rowPlayer(result.rows[0]),
        sessionId: result.rows[0].session_id as string,
      };
    });
  }

  async revokeSession(refreshTokenHash: string): Promise<void> {
    await this.pool.query(`
      UPDATE player_sessions SET revoked_at = now()
      WHERE refresh_token_hash = $1 AND revoked_at IS NULL
    `, [refreshTokenHash]);
  }

  async updatePlayerName(playerId: string, displayName: string): Promise<StoredPlayer | null> {
    const result = await this.pool.query(`
      UPDATE players
      SET display_name = $2, updated_at = now(), last_seen_at = now()
      WHERE id = $1
      RETURNING id, display_name, created_at
    `, [playerId, displayName]);
    return result.rowCount === 1 ? rowPlayer(result.rows[0]) : null;
  }

  async getPlayer(playerId: string): Promise<StoredPlayer | null> {
    const result = await this.pool.query(`
      UPDATE players SET last_seen_at = now()
      WHERE id = $1
      RETURNING id, display_name, created_at
    `, [playerId]);
    return result.rowCount === 1 ? rowPlayer(result.rows[0]) : null;
  }

  async recordMatch(record: MatchRecord): Promise<void> {
    await this.transaction(async (client) => {
      await client.query(`
        INSERT INTO matches (
          id, room_id, started_at, finished_at, difficulty, total_rounds,
          mode_order, winner_player_id, forfeited_player_id, result
        )
        VALUES (
          $1, $2, to_timestamp($3 / 1000.0), to_timestamp($4 / 1000.0),
          $5, $6, $7::jsonb, $8, $9, $10::jsonb
        )
        ON CONFLICT (id) DO NOTHING
      `, [
        record.id,
        record.roomId,
        record.startedAt,
        record.finishedAt,
        record.difficulty,
        record.totalRounds,
        JSON.stringify(record.modeOrder),
        record.authenticatedPlayerIds.has(record.result.winnerPlayerId ?? '')
          ? record.result.winnerPlayerId
          : null,
        record.authenticatedPlayerIds.has(record.result.forfeitedPlayerId ?? '')
          ? record.result.forfeitedPlayerId
          : null,
        JSON.stringify(record.result),
      ]);
      for (const player of record.players) {
        if (!record.authenticatedPlayerIds.has(player.id)) continue;
        await client.query(`
          INSERT INTO match_players (match_id, player_id, display_name, score)
          VALUES ($1, $2, $3, $4)
          ON CONFLICT (match_id, player_id) DO NOTHING
        `, [
          record.id,
          player.id,
          player.displayName,
          record.result.playerScores?.[player.id] ?? 0,
        ]);
      }
    });
  }

  async listMatches(playerId: string, limit: number): Promise<MatchHistoryItem[]> {
    const result = await this.pool.query(`
      SELECT
        match.id,
        match.room_id,
        match.started_at,
        match.finished_at,
        match.difficulty,
        match.total_rounds,
        match.mode_order,
        match.winner_player_id,
        match.forfeited_player_id,
        mine.score,
        COALESCE(opponent.display_name, 'DuelBot') AS opponent_display_name,
        COALESCE(opponent.score, 0) AS opponent_score
      FROM match_players AS mine
      JOIN matches AS match ON match.id = mine.match_id
      LEFT JOIN match_players AS opponent
        ON opponent.match_id = match.id AND opponent.player_id <> mine.player_id
      WHERE mine.player_id = $1
      ORDER BY match.finished_at DESC
      LIMIT $2
    `, [playerId, limit]);
    return result.rows.map((row) => ({
      id: row.id as string,
      roomId: row.room_id as string,
      startedAt: (row.started_at as Date).getTime(),
      finishedAt: (row.finished_at as Date).getTime(),
      difficulty: row.difficulty,
      totalRounds: row.total_rounds as number,
      modeOrder: row.mode_order,
      winnerPlayerId: row.winner_player_id,
      forfeitedPlayerId: row.forfeited_player_id,
      score: row.score as number,
      opponentDisplayName: row.opponent_display_name as string,
      opponentScore: row.opponent_score as number,
    }));
  }

  private async transaction<T>(operation: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await operation(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}
