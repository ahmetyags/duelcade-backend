import { Pool, type PoolClient } from 'pg';

import {
  CORE_MODES,
  COSMETIC_CATALOG,
  DAILY_QUESTS,
  coreModesInMatch,
  findCosmetic,
  levelFromXp,
  levelProgress,
  masteryXpForPlayer,
  matchXpForPlayer,
  utcDateKey,
  type CosmeticType,
  type QuestKey,
} from '../progression';
import type {
  CreateGuestSessionInput,
  DailyQuest,
  EquipCosmeticResult,
  InventoryItem,
  MatchHistoryItem,
  MatchRecord,
  ModeMastery,
  PersistenceStore,
  PlayerProgression,
  QuestClaimResult,
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
      if (applied.rowCount !== 1) {
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
      }

      const progressionApplied = await client.query(
        'SELECT 1 FROM schema_migrations WHERE id = $1',
        ['002_player_progression'],
      );
      if (progressionApplied.rowCount === 1) return;
      await client.query(`
        ALTER TABLE players
          ADD COLUMN total_xp integer NOT NULL DEFAULT 0,
          ADD COLUMN equipped_avatar varchar(40) NOT NULL DEFAULT 'sparkles',
          ADD COLUMN equipped_frame varchar(40) NOT NULL DEFAULT 'default',
          ADD COLUMN equipped_table_theme varchar(40) NOT NULL DEFAULT 'classic';

        ALTER TABLE match_players
          ADD COLUMN xp_earned integer NOT NULL DEFAULT 0;

        CREATE TABLE player_xp_ledger (
          player_id uuid NOT NULL REFERENCES players(id) ON DELETE CASCADE,
          source_type varchar(24) NOT NULL,
          source_id varchar(200) NOT NULL,
          xp integer NOT NULL CHECK (xp > 0),
          created_at timestamptz NOT NULL DEFAULT now(),
          PRIMARY KEY (player_id, source_type, source_id)
        );

        CREATE TABLE player_mode_mastery (
          player_id uuid NOT NULL REFERENCES players(id) ON DELETE CASCADE,
          mode varchar(40) NOT NULL,
          xp integer NOT NULL DEFAULT 0,
          matches_played integer NOT NULL DEFAULT 0,
          updated_at timestamptz NOT NULL DEFAULT now(),
          PRIMARY KEY (player_id, mode)
        );

        CREATE TABLE player_inventory (
          player_id uuid NOT NULL REFERENCES players(id) ON DELETE CASCADE,
          cosmetic_type varchar(24) NOT NULL,
          item_id varchar(40) NOT NULL,
          source varchar(80) NOT NULL,
          unlocked_at timestamptz NOT NULL DEFAULT now(),
          PRIMARY KEY (player_id, cosmetic_type, item_id)
        );

        CREATE TABLE player_daily_quests (
          player_id uuid NOT NULL REFERENCES players(id) ON DELETE CASCADE,
          quest_date date NOT NULL,
          quest_key varchar(40) NOT NULL,
          progress integer NOT NULL DEFAULT 0,
          target integer NOT NULL,
          reward_xp integer NOT NULL,
          claimed_at timestamptz,
          updated_at timestamptz NOT NULL DEFAULT now(),
          PRIMARY KEY (player_id, quest_date, quest_key)
        );
      `);
      for (const item of COSMETIC_CATALOG.filter((candidate) => candidate.unlockLevel === 1)) {
        await client.query(`
          INSERT INTO player_inventory (player_id, cosmetic_type, item_id, source)
          SELECT id, $1, $2, 'starter' FROM players
          ON CONFLICT DO NOTHING
        `, [item.type, item.itemId]);
      }
      await client.query(
        'INSERT INTO schema_migrations (id) VALUES ($1)',
        ['002_player_progression'],
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
      await this.grantUnlockedCosmetics(client, input.playerId, 1);
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
        const xpEarned = matchXpForPlayer(record, player.id);
        const awarded = await this.awardXp(
          client,
          player.id,
          'match',
          record.id,
          xpEarned,
        );
        if (!awarded) continue;
        await client.query(`
          UPDATE match_players SET xp_earned = $3
          WHERE match_id = $1 AND player_id = $2
        `, [record.id, player.id, xpEarned]);
        for (const mode of coreModesInMatch(record)) {
          await client.query(`
            INSERT INTO player_mode_mastery (
              player_id, mode, xp, matches_played
            )
            VALUES ($1, $2, $3, 1)
            ON CONFLICT (player_id, mode) DO UPDATE
            SET xp = player_mode_mastery.xp + EXCLUDED.xp,
                matches_played = player_mode_mastery.matches_played + 1,
                updated_at = now()
          `, [player.id, mode, masteryXpForPlayer(record, player.id)]);
        }
        const questDate = utcDateKey(new Date(record.finishedAt));
        await this.ensureDailyQuests(client, player.id, questDate);
        await this.incrementQuest(client, player.id, questDate, 'play_duel', 1);
        if (record.result.winnerPlayerId === player.id) {
          await this.incrementQuest(client, player.id, questDate, 'win_duel', 1);
        }
        const roundsWon = Math.max(0, record.result.playerScores?.[player.id] ?? 0);
        if (roundsWon > 0) {
          await this.incrementQuest(
            client,
            player.id,
            questDate,
            'win_rounds',
            roundsWon,
          );
        }
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
        mine.xp_earned,
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
      xpEarned: row.xp_earned as number,
    }));
  }

  async getProgression(
    playerId: string,
    date: string,
  ): Promise<PlayerProgression | null> {
    return this.transaction(async (client) => {
      await this.ensureDailyQuests(client, playerId, date);
      return this.readProgression(client, playerId, date);
    });
  }

  async claimDailyQuest(
    playerId: string,
    date: string,
    questKey: QuestKey,
  ): Promise<QuestClaimResult> {
    return this.transaction(async (client) => {
      await this.ensureDailyQuests(client, playerId, date);
      const quest = await client.query(`
        SELECT progress, target, reward_xp, claimed_at
        FROM player_daily_quests
        WHERE player_id = $1 AND quest_date = $2 AND quest_key = $3
        FOR UPDATE
      `, [playerId, date, questKey]);
      if (quest.rowCount !== 1) return { status: 'not_found' };
      const row = quest.rows[0];
      if (row.claimed_at) return { status: 'already_claimed' };
      if ((row.progress as number) < (row.target as number)) {
        return { status: 'not_complete' };
      }
      await this.awardXp(
        client,
        playerId,
        'daily_quest',
        `${date}:${questKey}`,
        row.reward_xp as number,
      );
      await client.query(`
        UPDATE player_daily_quests SET claimed_at = now(), updated_at = now()
        WHERE player_id = $1 AND quest_date = $2 AND quest_key = $3
      `, [playerId, date, questKey]);
      const progression = await this.readProgression(client, playerId, date);
      if (!progression) return { status: 'not_found' };
      return { status: 'claimed', progression };
    });
  }

  async equipCosmetic(
    playerId: string,
    type: CosmeticType,
    itemId: string,
    date: string,
  ): Promise<EquipCosmeticResult> {
    if (!findCosmetic(type, itemId)) return { status: 'invalid_item' };
    return this.transaction(async (client) => {
      const owned = await client.query(`
        SELECT 1 FROM player_inventory
        WHERE player_id = $1 AND cosmetic_type = $2 AND item_id = $3
      `, [playerId, type, itemId]);
      if (owned.rowCount !== 1) return { status: 'not_owned' };
      const column = type === 'avatar'
        ? 'equipped_avatar'
        : type === 'frame'
          ? 'equipped_frame'
          : 'equipped_table_theme';
      await client.query(
        `UPDATE players SET ${column} = $2, updated_at = now() WHERE id = $1`,
        [playerId, itemId],
      );
      await this.ensureDailyQuests(client, playerId, date);
      const progression = await this.readProgression(client, playerId, date);
      if (!progression) return { status: 'not_owned' };
      return { status: 'equipped', progression };
    });
  }

  private async awardXp(
    client: PoolClient,
    playerId: string,
    sourceType: string,
    sourceId: string,
    xp: number,
  ): Promise<boolean> {
    if (xp <= 0) return false;
    const ledger = await client.query(`
      INSERT INTO player_xp_ledger (player_id, source_type, source_id, xp)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT DO NOTHING
      RETURNING xp
    `, [playerId, sourceType, sourceId, xp]);
    if (ledger.rowCount !== 1) return false;
    const updated = await client.query(`
      UPDATE players SET total_xp = total_xp + $2, updated_at = now()
      WHERE id = $1
      RETURNING total_xp
    `, [playerId, xp]);
    if (updated.rowCount !== 1) throw new Error('PLAYER_NOT_FOUND');
    await this.grantUnlockedCosmetics(
      client,
      playerId,
      levelFromXp(updated.rows[0].total_xp as number),
    );
    return true;
  }

  private async grantUnlockedCosmetics(
    client: PoolClient,
    playerId: string,
    level: number,
  ): Promise<void> {
    for (const item of COSMETIC_CATALOG) {
      if (item.unlockLevel > level) continue;
      await client.query(`
        INSERT INTO player_inventory (
          player_id, cosmetic_type, item_id, source
        )
        VALUES ($1, $2, $3, $4)
        ON CONFLICT DO NOTHING
      `, [
        playerId,
        item.type,
        item.itemId,
        item.unlockLevel === 1 ? 'starter' : `level_${item.unlockLevel}`,
      ]);
    }
  }

  private async ensureDailyQuests(
    client: PoolClient,
    playerId: string,
    date: string,
  ): Promise<void> {
    for (const quest of DAILY_QUESTS) {
      await client.query(`
        INSERT INTO player_daily_quests (
          player_id, quest_date, quest_key, target, reward_xp
        )
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT DO NOTHING
      `, [playerId, date, quest.key, quest.target, quest.rewardXp]);
    }
  }

  private async incrementQuest(
    client: PoolClient,
    playerId: string,
    date: string,
    questKey: QuestKey,
    amount: number,
  ): Promise<void> {
    await client.query(`
      UPDATE player_daily_quests
      SET progress = LEAST(target, progress + $4), updated_at = now()
      WHERE player_id = $1 AND quest_date = $2 AND quest_key = $3
    `, [playerId, date, questKey, amount]);
  }

  private async readProgression(
    client: PoolClient,
    playerId: string,
    date: string,
  ): Promise<PlayerProgression | null> {
    const player = await client.query(`
      SELECT total_xp, equipped_avatar, equipped_frame, equipped_table_theme
      FROM players WHERE id = $1
    `, [playerId]);
    if (player.rowCount !== 1) return null;
    const totalXp = player.rows[0].total_xp as number;
    await this.grantUnlockedCosmetics(
      client,
      playerId,
      levelFromXp(totalXp),
    );
    const mastery = await client.query(`
      SELECT mode, xp, matches_played
      FROM player_mode_mastery WHERE player_id = $1
    `, [playerId]);
    const inventory = await client.query(`
      SELECT cosmetic_type, item_id, unlocked_at, source
      FROM player_inventory
      WHERE player_id = $1
      ORDER BY unlocked_at, cosmetic_type, item_id
    `, [playerId]);
    const quests = await client.query(`
      SELECT quest_key, progress, target, reward_xp, claimed_at
      FROM player_daily_quests
      WHERE player_id = $1 AND quest_date = $2
      ORDER BY quest_key
    `, [playerId, date]);
    const progress = levelProgress(totalXp);
    const masteryByMode = new Map(
      mastery.rows.map((row) => [row.mode as string, row]),
    );
    return {
      totalXp,
      ...progress,
      equipped: {
        avatar: player.rows[0].equipped_avatar as string,
        frame: player.rows[0].equipped_frame as string,
        tableTheme: player.rows[0].equipped_table_theme as string,
      },
      mastery: CORE_MODES.map((mode): ModeMastery => {
        const row = masteryByMode.get(mode);
        return {
          mode,
          xp: row?.xp as number ?? 0,
          matchesPlayed: row?.matches_played as number ?? 0,
        };
      }),
      inventory: inventory.rows.map((row): InventoryItem => ({
        type: row.cosmetic_type as CosmeticType,
        itemId: row.item_id as string,
        unlockedAt: (row.unlocked_at as Date).getTime(),
        source: row.source as string,
      })),
      catalog: COSMETIC_CATALOG,
      dailyQuests: quests.rows.map((row): DailyQuest => ({
        key: row.quest_key as QuestKey,
        date,
        progress: row.progress as number,
        target: row.target as number,
        rewardXp: row.reward_xp as number,
        claimed: row.claimed_at != null,
      })),
    };
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
