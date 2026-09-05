import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
let checked=0;
for(const base of ['resources/skills','resources/skills-catalog']) {
  for(const id of fs.readdirSync(base).filter(id=>id.startsWith('lily-'))) {
    const file=path.join(base,id,'skill.manifest.json'); if(!fs.existsSync(file)) continue;
    const manifest=JSON.parse(fs.readFileSync(file,'utf8'));
    for(const [locale,desc] of Object.entries({default:manifest.description,...manifest.description_i18n})) {
      assert.equal(typeof desc,'string',`${id}/${locale}: description must be text`);
      assert.ok(desc.trim().length>0 && desc.length<=600,`${id}/${locale}: description must be a short task trigger`);
      assert.ok(!/新增\s+scripts\/|；；|(?:v\d+\.\d+[^\n]*\n){2}/.test(desc),`${id}/${locale}: changelog belongs outside description`);
      checked++;
    }
  }
}
assert.ok(checked>30,'guard covers the first-party catalog');
console.log(`skill-description-quality: ok (${checked} descriptions)`);
