import assert from 'node:assert/strict';
import test from 'node:test';

import { isChatModelId, isValidModelId, modelSignature, withAgentModels } from './agent-models.mjs';

const CONFIG = {
  triageModel: 'gpt-4o-mini',
  categoriserModel: 'gpt-4o-mini',
  situationChooserModel: 'gpt-4o-mini',
  decomposerModel: '',
  investigatorModel: 'gpt-4o',
  draftingModel: 'gpt-4o',
  embeddingModel: 'text-embedding-3-small'
};

test('a chosen model replaces the env one, and nothing else moves', () => {
  const next = withAgentModels(CONFIG, { categorise: 'gpt-5-mini' });
  assert.equal(next.categoriserModel, 'gpt-5-mini');
  assert.equal(next.triageModel, 'gpt-4o-mini');
  assert.equal(CONFIG.categoriserModel, 'gpt-4o-mini');
});

test('no applicable row returns the same object, so a rebuild can be skipped', () => {
  assert.equal(withAgentModels(CONFIG, {}), CONFIG);
  assert.equal(withAgentModels(CONFIG, { categorise: 'gpt-4o-mini' }), CONFIG);
  assert.equal(withAgentModels(CONFIG, { chat: 'gpt-5.2' }), CONFIG);
  assert.equal(withAgentModels(CONFIG, { embed: 'text-embedding-3-large' }), CONFIG);
  assert.equal(withAgentModels(CONFIG, { draft: 'bad model; drop' }), CONFIG);
});

test('a row does not switch on a stage the env switched off', () => {
  assert.equal(withAgentModels(CONFIG, { decompose: 'gpt-4o-mini' }).decomposerModel, '');
});

test('the signature changes exactly when an overridable model does', () => {
  assert.equal(modelSignature(CONFIG), modelSignature({ ...CONFIG, embeddingModel: 'other' }));
  assert.notEqual(modelSignature(CONFIG), modelSignature(withAgentModels(CONFIG, { draft: 'gpt-5.2' })));
});

test('model ids', () => {
  for (const id of ['gpt-4o-mini', 'o3', 'gpt-5.2', 'ft:gpt-4o-mini:org::abc1']) assert.ok(isValidModelId(id), id);
  for (const id of ['', ' gpt-4o', 'gpt 4o', 'x'.repeat(101), null]) assert.ok(!isValidModelId(id), String(id));
  assert.ok(isChatModelId('gpt-4.1-mini'));
  assert.ok(isChatModelId('o4-mini'));
  assert.ok(!isChatModelId('text-embedding-3-small'));
  assert.ok(!isChatModelId('gpt-4o-realtime-preview'));
  assert.ok(!isChatModelId('whisper-1'));
});
