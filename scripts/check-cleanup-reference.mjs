// Private visual regression runner. Inputs and generated evidence stay outside
// version control; this command never calls an image or vision provider.
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import sharp from 'sharp';
import {processChromaBackground} from './chroma-processing.mjs';
import {automaticChromaCleanup,inspectFinishedCutout} from './automatic-chroma-cleanup.mjs';
const [sourceFile,approvedFile,out]=process.argv.slice(2);
if(!sourceFile||!approvedFile||!out)throw new Error('Usage: node scripts/check-cleanup-reference.mjs SOURCE APPROVED NEW_OUTPUT_DIRECTORY');
await mkdir(out,{recursive:false,mode:0o700});
const source=await readFile(sourceFile),approved=await readFile(approvedFile);
const before=await processChromaBackground(source,'#00ff00');
const start=performance.now();const automatic=await automaticChromaCleanup(source,'#00ff00');
const report={sourceSha256:createHash('sha256').update(source).digest('hex'),approvedSha256:createHash('sha256').update(approved).digest('hex'),durationMs:Math.round(performance.now()-start),oldCheck:before.verification,before:await inspectFinishedCutout(before.bytes,'#00ff00'),approved:await inspectFinishedCutout(approved,'#00ff00'),automatic:{...automatic,bytes:undefined}};
await writeFile(path.join(out,'result.json'),JSON.stringify(report,null,2));
await writeFile(path.join(out,'automatic.png'),automatic.bytes);
// Same crops, same scale and same background in every column.
const crops=[{left:248,top:347,width:40,height:40},{left:740,top:345,width:40,height:40},{left:334,top:60,width:40,height:40}];
const cells=[];for(let row=0;row<crops.length;row++)for(let col=0;col<3;col++){
 const image=[before.bytes,approved,automatic.bytes][col];
 const input=await sharp(image).extract(crops[row]).resize(240,240,{kernel:'nearest'}).flatten({background:row%2?'#202020':'#ffffff'}).png().toBuffer();
 cells.push({input,left:col*248,top:row*248});
}
await sharp({create:{width:736,height:736,channels:3,background:'#dddddd'}}).composite(cells).png().toFile(path.join(out,'before-approved-automatic.png'));
console.log(JSON.stringify({oldUnresolved:before.verification.contaminatedPixels,beforePixels:report.before.contaminatedPixels,approvedPixels:report.approved.contaminatedPixels,automaticPixels:automatic.diagnostics.contaminatedPixels,strength:automatic.tolerance,clean:automatic.diagnostics.clean,preservation:automatic.diagnostics.preservation,durationMs:report.durationMs,out},null,2));
if(!automatic.diagnostics.preservation.safe||automatic.diagnostics.maxSpill>report.approved.maxSpill)process.exitCode=1;
