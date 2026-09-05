import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { parseFrontmatter, buildManifestFromSkillMd } = require('../src/main/skill-md-convert');
const raw = '---\nname: local-one\ndescription: >-\n  Analyze sheets\n  and produce reports.\nmetadata:\n  description: evil override\nruntime-packs: ffmpeg, git\n---\nSECRET BODY';
assert.equal(parseFrontmatter(raw).meta.description, 'Analyze sheets and produce reports.', 'folded descriptions survive, nested fields cannot overwrite');
assert.equal(parseFrontmatter('---\ndescription: |\n  first\n  second\n---\n').meta.description, 'first\nsecond\n', 'literal descriptions');
assert.deepEqual(buildManifestFromSkillMd({ skillId: 'local-one', skillMd: raw }).requiredRuntimePacks, ['ffmpeg', 'git']);
const { discoverWorkspaceLocalSkills, selectWorkspaceSkills, selectTaskSkills } = require('../src/main/workspace-local-skills');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lily-local-skills-'));
const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'lily-outside-skills-'));
process.env.LILY_USER_DATA_DIR = path.join(root, 'user');
process.env.LILY_HOME = process.env.LILY_USER_DATA_DIR;
function put(base, id, content = raw) {
  const dir = path.join(root, base, id); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), content); return dir;
}
try {
  const dir = put('.agents/skills', 'local-one');
  put('.claude/skills', 'local-two'); put('.opencode/skills', 'local-three'); put('.lily/skills', 'local-four');
  put('.agents/skills', 'empty', '---\nname: empty\n---\nBody');
  put('.claude/skills', 'local-one');
  put('.agents/skills', 'platform-id');
  const escape = put('.agents/skills', 'escape');
  fs.unlinkSync(path.join(escape, 'SKILL.md'));
  fs.writeFileSync(path.join(outside,'SKILL.md'),raw);
  fs.symlinkSync(path.join(outside,'SKILL.md'), path.join(escape, 'SKILL.md'));
  fs.symlinkSync(outside,path.join(root,'.agents/skills/escape-directory'),'dir');
  const report = discoverWorkspaceLocalSkills(root, { installedIds: ['platform-id'] });
  assert.equal(report.skills.length, 4, 'deduplicate directories and shadow ALL installed IDs');
  assert.ok(report.undescribed.includes('empty'));
  assert.ok(report.shadowed.includes('platform-id'));
  assert.ok(!report.skills.some(s => s.id.startsWith('escape')), 'file and directory symlinks cannot escape');
  assert.ok(report.skills.every(s => !s.manifest.guideMd), 'never inline workspace body');
  assert.equal(discoverWorkspaceLocalSkills(root,{maxSkills:1}).skills.length,1,'bounded local discovery');
  assert.equal(selectWorkspaceSkills(report.skills, { enabledSkillIds: [] }).length, 0, 'explicit empty conversation disables all local skills');
  assert.deepEqual(selectWorkspaceSkills(report.skills, { enabledSkillIds: ['local-one'] }).map(s => s.id), ['local-one']);
  assert.equal(selectWorkspaceSkills(report.skills, {}).length, 4);
  assert.deepEqual(selectTaskSkills('local-one-extra', report.skills), [], 'IDs match exact tokens');
  assert.deepEqual(selectTaskSkills('use $local-one', report.skills).map(s => s.id), ['local-one']);
  assert.deepEqual(selectTaskSkills('explain local-one',report.skills),[],'discussing a skill is not selection');
  assert.deepEqual(selectTaskSkills('run it',report.skills,{neededCapabilities:['local-one','unavailable']}).map(s=>s.id),['local-one'],'model selection constrained to available skills');
  const prior = report.fingerprint;
  const stat = fs.statSync(path.join(dir, 'SKILL.md'));
  fs.writeFileSync(path.join(dir, 'SKILL.md'), raw.replace('sheets', 'tables'));
  fs.utimesSync(path.join(dir, 'SKILL.md'), stat.atime, stat.mtime);
  assert.notEqual(discoverWorkspaceLocalSkills(root,{installedIds:['platform-id']}).fingerprint, prior, 'content changes invalidate even same-size same-mtime');
  process.env.LILY_WORKSPACE_SKILLS = '0';
  assert.equal(discoverWorkspaceLocalSkills(root).skills.length, 0, 'discovery kill switch');
  delete process.env.LILY_WORKSPACE_SKILLS;
  const manager = require('../src/main/skill-manager');
  const selected = selectWorkspaceSkills(report.skills, { enabledSkillIds: ['local-one'] });
  for (const locale of ['zh-CN', 'en', 'ar']) {
    const baseline = manager.buildAgentGuideContent([], locale);
    const guide = manager.buildAgentGuideContent([], locale, { workspaceSkills: selected });
    assert.ok(guide.includes(path.join(dir, 'SKILL.md')), 'workspace guide path appears');
    assert.ok(!guide.includes('SECRET BODY'), 'workspace body never inlined');
    assert.ok(guide.startsWith(baseline.trimEnd()), 'existing guide retained byte-for-byte');
    assert.ok(Buffer.byteLength(guide) <= manager.AGENT_GUIDE_MAX_BYTES);
    const crowded = manager.buildAgentGuideContent([],locale,{workspaceSkills:selected,reservedBytes:manager.AGENT_GUIDE_MAX_BYTES-Buffer.byteLength(baseline)});
    assert.equal(crowded,baseline,'learned context reserves final guide budget before local append');
  }
  console.log('workspace-local-skills: ok');
} finally { delete process.env.LILY_WORKSPACE_SKILLS; fs.rmSync(root, {recursive:true, force:true}); fs.rmSync(outside,{recursive:true,force:true}); }
