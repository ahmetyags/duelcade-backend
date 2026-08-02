/**
 * Room template definitions for procedural level generation.
 * Each room follows the Procedural Room Rules from Bölüm 5:
 * entry point, exit point, puzzle slots and decor slots.
 *
 * Rooms are designed as data (not code) so new rooms can be added
 * without modifying the generator — per the acceptance criteria.
 */

import type { RoomTemplate } from '@/types/puzzle';

export const ROOM_TEMPLATES: Record<string, RoomTemplate> = {
  control_room: {
    id: 'control_room',
    displayName: 'Control Room',
    description: 'The central command hub with surveillance monitors and security panels.',
    entryPoint: { x: 50, y: 400 },
    exitPoint: { x: 700, y: 200 },
    bounds: { width: 750, height: 450 },
    themeColor: '#22D3EE',
    puzzleSlots: [
      {
        id: 'slot_cr_1',
        position: { x: 200, y: 150 },
        allowedCategories: ['code', 'logic'],
        allowedRoles: ['operator', 'explorer'],
      },
      {
        id: 'slot_cr_2',
        position: { x: 500, y: 300 },
        allowedCategories: ['circuit', 'camera'],
        allowedRoles: ['operator', 'explorer'],
      },
    ],
    decorSlots: [
      { id: 'decor_cr_1', position: { x: 100, y: 100 }, decorType: 'monitor_bank' },
      { id: 'decor_cr_2', position: { x: 600, y: 100 }, decorType: 'control_desk' },
      { id: 'decor_cr_3', position: { x: 350, y: 50 }, decorType: 'warning_sign' },
    ],
  },

  laboratory: {
    id: 'laboratory',
    displayName: 'Laboratory',
    description: 'An abandoned research lab with experimental equipment and chemical stations.',
    entryPoint: { x: 50, y: 225 },
    exitPoint: { x: 750, y: 225 },
    bounds: { width: 800, height: 450 },
    themeColor: '#22C55E',
    puzzleSlots: [
      {
        id: 'slot_lab_1',
        position: { x: 300, y: 200 },
        allowedCategories: ['circuit', 'logic', 'pressure_plate'],
        allowedRoles: ['operator', 'explorer'],
      },
      {
        id: 'slot_lab_2',
        position: { x: 550, y: 350 },
        allowedCategories: ['code', 'symbol'],
        allowedRoles: ['operator', 'explorer'],
      },
    ],
    decorSlots: [
      { id: 'decor_lab_1', position: { x: 200, y: 100 }, decorType: 'lab_table' },
      { id: 'decor_lab_2', position: { x: 500, y: 100 }, decorType: 'fume_hood' },
      { id: 'decor_lab_3', position: { x: 650, y: 300 }, decorType: 'shelves' },
    ],
  },

  archive: {
    id: 'archive',
    displayName: 'Archive',
    description: 'Rows of filing cabinets and data terminals in the facility records room.',
    entryPoint: { x: 400, y: 400 },
    exitPoint: { x: 400, y: 50 },
    bounds: { width: 800, height: 450 },
    themeColor: '#8B5CF6',
    puzzleSlots: [
      {
        id: 'slot_arch_1',
        position: { x: 200, y: 300 },
        allowedCategories: ['symbol', 'memory_sequence', 'logic'],
        allowedRoles: ['operator', 'explorer'],
      },
      {
        id: 'slot_arch_2',
        position: { x: 600, y: 200 },
        allowedCategories: ['map', 'code'],
        allowedRoles: ['operator', 'explorer'],
      },
    ],
    decorSlots: [
      { id: 'decor_arch_1', position: { x: 100, y: 150 }, decorType: 'filing_cabinet' },
      { id: 'decor_arch_2', position: { x: 700, y: 150 }, decorType: 'filing_cabinet' },
      { id: 'decor_arch_3', position: { x: 400, y: 350 }, decorType: 'data_terminal' },
    ],
  },

  generator_room: {
    id: 'generator_room',
    displayName: 'Generator Room',
    description: 'The facility power plant with humming turbines and electrical panels.',
    entryPoint: { x: 50, y: 200 },
    exitPoint: { x: 750, y: 250 },
    bounds: { width: 800, height: 450 },
    themeColor: '#F59E0B',
    puzzleSlots: [
      {
        id: 'slot_gen_1',
        position: { x: 350, y: 150 },
        allowedCategories: ['circuit', 'timing'],
        allowedRoles: ['operator', 'explorer'],
      },
      {
        id: 'slot_gen_2',
        position: { x: 550, y: 350 },
        allowedCategories: ['pressure_plate', 'circuit'],
        allowedRoles: ['operator', 'explorer'],
      },
    ],
    decorSlots: [
      { id: 'decor_gen_1', position: { x: 150, y: 100 }, decorType: 'turbine' },
      { id: 'decor_gen_2', position: { x: 650, y: 100 }, decorType: 'power_panel' },
      { id: 'decor_gen_3', position: { x: 400, y: 300 }, decorType: 'pipe_cluster' },
    ],
  },

  server_room: {
    id: 'server_room',
    displayName: 'Server Room',
    description: 'Racks of blinking servers with network terminals and cooling systems.',
    entryPoint: { x: 100, y: 400 },
    exitPoint: { x: 700, y: 100 },
    bounds: { width: 800, height: 450 },
    themeColor: '#22D3EE',
    puzzleSlots: [
      {
        id: 'slot_srv_1',
        position: { x: 300, y: 250 },
        allowedCategories: ['memory_sequence', 'code', 'logic'],
        allowedRoles: ['operator', 'explorer'],
      },
      {
        id: 'slot_srv_2',
        position: { x: 600, y: 300 },
        allowedCategories: ['circuit', 'timing'],
        allowedRoles: ['operator', 'explorer'],
      },
    ],
    decorSlots: [
      { id: 'decor_srv_1', position: { x: 150, y: 150 }, decorType: 'server_rack' },
      { id: 'decor_srv_2', position: { x: 450, y: 150 }, decorType: 'server_rack' },
      { id: 'decor_srv_3', position: { x: 650, y: 200 }, decorType: 'cooling_unit' },
    ],
  },

  escape_gate: {
    id: 'escape_gate',
    displayName: 'Escape Gate',
    description: 'The final exit — a reinforced blast door with a complex locking mechanism.',
    entryPoint: { x: 50, y: 225 },
    exitPoint: { x: 750, y: 225 },
    bounds: { width: 800, height: 450 },
    themeColor: '#22C55E',
    puzzleSlots: [
      {
        id: 'slot_esc_1',
        position: { x: 400, y: 225 },
        allowedCategories: ['code', 'symbol', 'circuit', 'logic'],
        allowedRoles: ['operator', 'explorer'],
      },
    ],
    decorSlots: [
      { id: 'decor_esc_1', position: { x: 200, y: 100 }, decorType: 'blast_door_frame' },
      { id: 'decor_esc_2', position: { x: 600, y: 100 }, decorType: 'warning_lights' },
      { id: 'decor_esc_3', position: { x: 400, y: 380 }, decorType: 'floor_grate' },
    ],
  },
};

/** Get a room template by ID. */
export function getRoomTemplate(id: string): RoomTemplate | undefined {
  return ROOM_TEMPLATES[id];
}

/** Get all room template IDs. */
export function getAllRoomTemplateIds(): string[] {
  return Object.keys(ROOM_TEMPLATES);
}
