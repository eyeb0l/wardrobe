import fs from 'node:fs';import path from 'node:path';
const [outFile,...folders]=process.argv.slice(2);if(!folders.length)throw Error('OUTPUT_GRADES BLIND_FOLDER...');
const grades={},provenance={};
for(const dir of folders){const mapping=JSON.parse(fs.readFileSync(path.join(dir,'mapping-private.json')));for(const f of fs.readdirSync(dir).filter(f=>/^grades-.*\.json$/.test(f))){const raw=JSON.parse(fs.readFileSync(path.join(dir,f)));for(const [id,g]of Object.entries(raw)){if(!mapping[id])throw Error('Unmapped review '+id);const attempt=mapping[id];if(grades[attempt])throw Error('Conflicting repeated review: adjudicate explicitly '+attempt);grades[attempt]=g;provenance[attempt]={file:path.join(dir,f),answerId:id};}}}
fs.writeFileSync(outFile,JSON.stringify(grades,null,2));fs.writeFileSync(outFile+'.provenance.json',JSON.stringify(provenance,null,2));console.log('Merged grades:',Object.keys(grades).length);
