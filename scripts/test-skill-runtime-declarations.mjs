#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire, Module } from 'node:module';
const require = createRequire(import.meta.url);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-runtime-'));
process.env.LILY_USER_DATA_DIR = tmp;
try {
  const { normalizeRuntimePackIds, declaredRuntimePacksForSkill } = require('../src/main/skill-runtime-declarations');
  assert.deepEqual(normalizeRuntimePackIds(['ffmpeg','git','ffmpeg','constructor','__proto__','unknown',{},null]), ['ffmpeg','git']);
  assert.deepEqual(normalizeRuntimePackIds(Array(65).fill('ffmpeg')), []);
  assert.deepEqual(normalizeRuntimePackIds('ffmpeg'), []);
  const state = require('../src/main/skills-state');
  const dir = state.installedSkillDir('test-runtime');
  fs.mkdirSync(dir, { recursive: true });
  const write = packs => fs.writeFileSync(path.join(dir,'skill.manifest.json'), JSON.stringify({schemaVersion:1,id:'test-runtime',requiredRuntimePacks:packs}));
  write(['ffmpeg']);
  const registry = {skills:[{id:'test-runtime', requiredRuntimePacks:['git']}]};
  assert.deepEqual(declaredRuntimePacksForSkill('test-runtime',{registry}), ['ffmpeg','git']);
  write(['pandoc']);
  assert.deepEqual(declaredRuntimePacksForSkill('test-runtime',{registry}), ['pandoc','git'], 'manifest changes are read fresh');
  assert.deepEqual(declaredRuntimePacksForSkill('../test-runtime',{registry}), []);
  for (const manifest of [
    {schemaVersion:999,requiredRuntimePacks:['ffmpeg']},
    {id:'different-skill',requiredRuntimePacks:['ffmpeg']},
  ]) assert.deepEqual(declaredRuntimePacksForSkill('test-runtime',{manifest,registry}), ['git'], 'invalid identity/schema retains registry only');
  fs.writeFileSync(path.join(dir,'skill.manifest.json'), JSON.stringify({schemaVersion:1,id:'different-skill',requiredRuntimePacks:['ffmpeg']}));
  assert.deepEqual(declaredRuntimePacksForSkill('test-runtime',{registry}), ['git'], 'installed identity must match the requested skill');
  write(['pandoc']);
  const bad = {get requiredRuntimePacks(){throw Error('bad');}};
  assert.deepEqual(declaredRuntimePacksForSkill('test-runtime',{manifest:bad,registry}), ['git']);
  const {runtimePackIdsForSkills, SKILL_RUNTIME_PACKS} = require('../src/main/runtime-pack-preflight');
  assert.deepEqual(runtimePackIdsForSkills(['test-runtime']), ['pandoc']);
  const legacyDir = state.installedSkillDir('lily-template-fill');
  fs.mkdirSync(legacyDir,{recursive:true});
  fs.writeFileSync(path.join(legacyDir,'skill.manifest.json'), JSON.stringify({schemaVersion:1,id:'lily-template-fill',requiredRuntimePacks:['git']}));
  assert.deepEqual(new Set(runtimePackIdsForSkills(['lily-template-fill'])), new Set(['libreoffice','git']));
  const bundled = require('../src/main/skill-registry').loadBundledRegistry();
  for(const [id, expected] of Object.entries(SKILL_RUNTIME_PACKS)) {
    const paths = ['skills-catalog','skills'].map(p=>path.resolve('resources',p,id,'skill.manifest.json'));
    const manifest = paths.find(p=>fs.existsSync(p));
    const declared = manifest ? JSON.parse(fs.readFileSync(manifest)).requiredRuntimePacks : bundled.skills.find(s=>s.id===id)?.requiredRuntimePacks;
    assert.deepEqual(new Set(declared), new Set(expected), `declaration drift: ${id}`);
  }
  // Execute the real finalizer with only host state/shim effects isolated.
  const installerPath = path.resolve('src/main/skill-github-installer.js');
  const installerModule = new Module(installerPath);
  installerModule.filename = installerPath;
  const installerRequire = createRequire(installerPath);
  installerModule.require = id => id === './skills-state' ? {
    ...state, buildReplacements: () => ({}), applyPlaceholders: text => text,
    loadSkillsState: () => ({skills:{}}), saveSkillsState: () => {},
  } : installerRequire(id);
  installerModule._compile(fs.readFileSync(installerPath,'utf8') + '\nmodule.exports.finalizeInstalledSkill = finalizeInstalledSkill;', installerPath);
  for (const existing of [false,true]) {
    const id = existing ? 'test-existing' : 'test-generated';
    const source = path.join(tmp,id);
    fs.mkdirSync(source);
    fs.writeFileSync(path.join(source,'SKILL.md'), '---\nname: example\ndescription: test\n---\nInstructions');
    if(existing) fs.writeFileSync(path.join(source,'skill.manifest.json'),JSON.stringify({id,schemaVersion:1,requiredRuntimePacks:['git']}));
    assert.equal(installerModule.exports.finalizeInstalledSkill({id,latestVersion:'1.0.0',github:{repo:'a/b',path:'skill'},requiredRuntimePacks:['ffmpeg','constructor']},source).ok,true);
    const installed = JSON.parse(fs.readFileSync(path.join(state.installedSkillDir(id),'skill.manifest.json')));
    assert.deepEqual(installed.requiredRuntimePacks,existing ? ['git','ffmpeg'] : ['ffmpeg']);
  }
  process.env.LILY_SKILL_RUNTIME_DECLARATIONS='0';
  assert.deepEqual(declaredRuntimePacksForSkill('test-runtime',{registry}), []);
  assert.deepEqual(runtimePackIdsForSkills(['lily-template-fill']), ['libreoffice']);
  delete process.env.LILY_SKILL_RUNTIME_DECLARATIONS;
  console.log('skill runtime declarations: ok');
} finally {fs.rmSync(tmp,{recursive:true,force:true});}
