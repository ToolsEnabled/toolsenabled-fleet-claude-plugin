'use strict';

const TASK_DIFFICULTY_SETTING_ID = 'agent.task_difficulty_enabled';
const DIFFICULTIES = Object.freeze(['easy', 'medium', 'hard']);

function refuse(code, message) {
  throw Object.assign(new Error(message), { code });
}

function normalizeTaskDifficulty(value) {
  if (!DIFFICULTIES.includes(value)) {
    refuse('T_LEDGER_DIFFICULTY_INVALID', 'Task difficulty must be easy, medium or hard.');
  }
  return value;
}

function newTaskDifficultyFields({ difficulty, enabled = false } = {}) {
  if (enabled !== true) return Object.freeze({});
  if (difficulty === undefined || difficulty === null) {
    refuse('T_LEDGER_DIFFICULTY_REQUIRED', 'Choose easy, medium or hard when filing a task.');
  }
  return Object.freeze({ difficulty: normalizeTaskDifficulty(difficulty), failedReviewCount: 0 });
}

module.exports = {
  TASK_DIFFICULTY_SETTING_ID, DIFFICULTIES, normalizeTaskDifficulty, newTaskDifficultyFields,
};
