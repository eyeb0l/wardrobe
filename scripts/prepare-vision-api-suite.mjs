// Offline request capture: production middleware, dummy credentials, no live transport.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { wardrobeImportApi } from './import-job-api.mjs';
import { wardrobeOutfitApi } from './outfit-api.mjs';
import { wardrobeShoppingApi } from './shopping-api.mjs';

const BASE = 'https://offline-evaluation.invalid/v1';
const sha256 = value => createHash('sha256').update(value).digest('hex');
const SOURCE_FILES = ['scripts/import-job-api.mjs','scripts/outfit-api.mjs','scripts/shopping-api.mjs','scripts/modeled-photo-prompts.mjs','src/image-upload.mjs','src/shopping-image.mjs','scripts/prepare-vision-api-suite.mjs'];
export const CURATION_BRIEFS = [
  'Three distinct everyday looks: one relaxed, one smart-casual and one restrained layered option.',
  'Three distinct cool-weather looks. Keep every selected top visible; inspect whether each outer layer really opens.',
  'Three warm-weather daytime looks using different top-and-bottom pairs, with practical footwear where available.',
  'Three dark tonal dinner looks with restrained accessories and visibly different silhouettes.',
  'Three smart-casual workday looks. Balance clean proportions and avoid inventing a formal dress code.',
  'Three outfits for an informal evening out; include one pattern-led outfit without stacking competing prints.',
  'Three relaxed weekend looks with varied garment use. Prefer underused pieces when the combination works.',
  'Three outfits featuring skirts, with coherent tops and footwear; include restrained layering only when plausible.',
  'Three looks centered on light or muted colors. Vary the top-and-bottom pairs and balance silhouette.',
  'Three looks that test the available outer layers. Never invent an opening or completely hide the selected top.',
];
export const SCENE_NAMES = ['black v-neck t-shirt','black floral button-front skirt','two-tone ballet flats','gold hoop earrings','light blue-gray button-up shirt'];
const SCENE_DIRECTIONS = ['', 'A different real-world setting from the previous image; keep the whole skirt clear.', 'A close detail photograph with the entire matching pair visible.', 'A restrained setting that preserves the metal color and both earrings.', 'A relaxed daytime setting with the front construction and sleeves visible.'];

export async function send(plugin, method, url, payload) {
  let handler;
  plugin.configureServer({ middlewares: { use(value) { handler = value; } } });
  const bytes = payload === undefined ? null : Buffer.from(JSON.stringify(payload));
  const req = Readable.from(bytes ? [bytes] : []);
  Object.assign(req, { method, url, headers: { host:'localhost', 'content-type':'application/json', ...(bytes ? {'content-length':String(bytes.length)} : {}) } });
  let body;
  const res = { statusCode:200, setHeader() {}, end(value) { body = JSON.parse(value); } };
  await handler(req,res,()=>{ throw new Error(`Unmatched offline route ${url}`); });
  return {status:res.statusCode,body};
}

export async function browserPreparer({projectRoot=process.cwd(),playwrightModule}={}) {
  const location = playwrightModule || process.env.VISION_EVAL_PLAYWRIGHT_MODULE || '/Users/iris/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs';
  const { chromium } = await import(pathToFileURL(location).href);
  const browser = await chromium.launch({headless:true});
  const page = await browser.newPage();
  await page.route('**/*', route => route.abort());
  const source = await fs.readFile(path.join(projectRoot,'src/image-upload.mjs'),'utf8');
  const moduleUrl = `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
  return {
    version:browser.version(),
    async prepare(file,shopping=false) {
      const original = await fs.readFile(file);
      const result = await page.evaluate(async ({encoded,moduleUrl,shopping}) => {
        const module = await import(moduleUrl);
        const bytes = Uint8Array.from(atob(encoded),x=>x.charCodeAt(0));
        const result = await module.prepareUploadImage(new File([bytes],'fixture'),shopping ? {preserveSmall:false,maxEdge:1600} : undefined);
        const {blob,...serializable} = result;
        return serializable;
      },{encoded:original.toString('base64'),moduleUrl,shopping});
      return {...result,originalSha256:sha256(original)};
    },
    close:()=>browser.close(),
  };
}

export async function createCaptureHarness({snapshot,accessoryFiles=[]}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(),'wardrobe-api-capture-'));
  const data = path.join(root,'data');
  await fs.cp(snapshot,data,{recursive:true});
  await fs.mkdir(path.join(data,'outfit-images'),{recursive:true});
  for (const entry of accessoryFiles) {
    const source=path.isAbsolute(entry.file)?entry.file:path.join(snapshot,entry.file);
    const destination=path.join(data,'outfit-images',path.basename(entry.image||entry.file));
    if(path.resolve(source)!==path.resolve(destination)) await fs.copyFile(source,destination);
  }
  const env = { OPENAI_API_KEY:'offline-fixture-key', OPENAI_API_BASE_URL:BASE, OPENAI_VISION_MODEL:'gpt-5.6-luna', OPENAI_IMAGE_MODEL:'offline-image-disabled', OPENAI_MODELED_MODEL:'offline-image-disabled', WARDROBE_DATA_DIR:'data', WARDROBE_MODEL_REFERENCE:'data/model-reference.png' };
  const captures = [], scheduled = [];
  const transport = async (url,options) => {
    if (url !== `${BASE}/responses`) throw new Error(`Forbidden transport endpoint: ${url}`);
    if (options.headers.Authorization !== 'Bearer offline-fixture-key') throw new Error('Fixture credential mismatch');
    captures.push(JSON.parse(options.body));
    // A terminal provider error ends production execution before any generation.
    return Response.json({error:{message:'Offline fixture captured; do not retry'}},{status:400});
  };
  const beforePaidCall = kind => { if(kind !== 'text') throw new Error('Image generation is forbidden'); };
  const scheduleTask = task => { scheduled.push(task); };
  const imports = wardrobeImportApi({env,serverless:true,scheduleTask,beforePaidCall});
  const outfits = wardrobeOutfitApi({env,serverless:true,scheduleTask,beforePaidCall,fetch:transport});
  const shopping = wardrobeShoppingApi({env,fetch:transport,beforePaidCall,timeoutMs:120000});
  for (const plugin of [imports,outfits,shopping]) await plugin.configResolved({root});
  async function capture(action) {
    const count = captures.length;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = transport;
    try { await action(); }
    finally { globalThis.fetch = originalFetch; }
    if (captures.length !== count + 1) throw new Error(`Expected exactly one captured request; got ${captures.length-count}`);
    return captures.at(-1);
  }
  return {root,data,imports,outfits,shopping,
    captureDetection: imageDataUrl => capture(()=>send(imports,'POST','/api/import/jobs',{imageDataUrl})),
    captureShopping: (image,notes,wardrobeItems) => capture(()=>send(shopping,'POST','/api/shopping/analyze',{image,notes,wardrobeItems,modelReferenceId:'default'})),
    captureCuration: direction => capture(async()=>{
      const created = await send(outfits,'POST','/api/outfits/jobs',{count:3,direction,modelReferenceId:'default'});
      if(created.status !== 202) throw new Error(`Curation setup: ${JSON.stringify(created)}`);
      await outfits.runTask(scheduled.pop());
    }),
    captureScene: (item,direction='') => capture(async()=>{
      const created = await send(imports,'POST',`/api/import/wardrobe/${item.id}/modeled`,{});
      if(created.status !== 200) throw new Error(`Scene setup: ${JSON.stringify(created)}`);
      const generated = await send(imports,'POST',`/api/import/jobs/${created.body.id}/stages/modeled/regenerate`,{prompt:direction,modelReferenceId:'default'});
      if(generated.status !== 202) throw new Error(`Scene setup: ${JSON.stringify(generated)}`);
      await imports.runTask(scheduled.pop());
    }),
    captureAccessories: id => capture(()=>send(outfits,'POST',`/api/outfits/${id}/accessories`,{})),
    async close(){await outfits.closeBundle();shopping.closeBundle();await fs.rm(root,{recursive:true,force:true});},
  };
}

export async function externalizeRequest(request,out,imageHashes) {
  const result = structuredClone(request);
  for(const message of result.input) for(const image of message.content || []) if(image.type === 'input_image') {
    const match = image.image_url?.match(/^data:(image\/\w+);base64,(.+)$/s);
    if(!match) throw new Error('Only captured inline images allowed');
    const bytes = Buffer.from(match[2],'base64'), hash = sha256(bytes);
    const name = `inputs/${hash.slice(0,24)}.${match[1] === 'image/jpeg' ? 'jpg' : 'png'}`;
    await fs.mkdir(path.join(out,'inputs'),{recursive:true});
    await fs.writeFile(path.join(out,name),bytes,{mode:0o600});
    imageHashes[name] = hash;
    delete image.image_url;
    image.image_path = name;
    image.mime_type = match[1];
  }
  return result;
}

export async function prepareSuite({snapshot,retailerManifest,accessoryManifest,out,projectRoot=process.cwd(),playwrightModule}) {
  snapshot=path.resolve(snapshot);out=path.resolve(out);
  const snapshotMetadata=JSON.parse(await fs.readFile(path.join(snapshot,'snapshot.json'),'utf8'));
  if(snapshotMetadata.target !== 'cloud') throw new Error('Evaluation requires current cloud snapshot');
  const library=JSON.parse(await fs.readFile(path.join(snapshot,'library.json'),'utf8'));
  const retailers=retailerManifest ? JSON.parse(await fs.readFile(retailerManifest,'utf8')) : {cases:[]};
  const accessories=accessoryManifest ? JSON.parse(await fs.readFile(accessoryManifest,'utf8')) : [];
  const accessoryFiles=Array.isArray(accessories)?accessories:(accessories.outfits||accessories.records);
  const savedOutfits=JSON.parse(await fs.readFile(path.join(snapshot,'outfits.json'),'utf8')).outfits;
  const excludedPairs=savedOutfits.filter(x=>x.status==='accepted').map(x=>(x.garmentIds||[]).filter(id=>['upperbody','lowerbody'].includes(library.find(item=>item.id===id)?.part)).sort()).filter(x=>x.length===2);
  await fs.mkdir(out,{recursive:true,mode:0o700});
  try {await fs.access(path.join(out,'suite.json'));throw new Error('Refusing to overwrite frozen suite');}catch(e){if(e.code!=='ENOENT')throw e;}
  const harness=await createCaptureHarness({snapshot,accessoryFiles});
  let browser;
  const cases=[],imageHashes={},preprocessing=[];
  async function add(spec,request) {cases.push({...spec,capturedRequestSha256:sha256(JSON.stringify(request)),request:await externalizeRequest(request,out,imageHashes)});}
  try {
    for(const [i,direction] of CURATION_BRIEFS.entries()) await add({id:`curation-${String(i+1).padStart(2,'0')}`,task:'curation',split:i<2?'screen':'confirm',family:`curation-context-${i<2?'screen':'confirm'}`,timeoutMs:210000,direction,annotations:{expectedCount:3,excludedPairs,inventoryIds:library.filter(x=>x.part!=='dresses').map(x=>x.id)}},await harness.captureCuration(direction));
    for(const [i,name] of SCENE_NAMES.entries()) {
      const item=library.find(x=>x.name===name);if(!item)throw new Error(`Missing scene garment: ${name}`);
      await add({id:`scene-${String(i+1).padStart(2,'0')}`,task:'scene',split:i===0?'screen':'confirm',family:`scene-${item.id}`,timeoutMs:30000,garmentId:item.id,direction:SCENE_DIRECTIONS[i]},await harness.captureScene(item,SCENE_DIRECTIONS[i]));
    }
    for(const [i,entry] of accessoryFiles.entries()) await add({id:`accessories-${String(i+1).padStart(2,'0')}`,task:'accessories',split:i===0?'screen':'confirm',family:`saved-outfit-${entry.id}`,timeoutMs:210000,outfitId:entry.id},await harness.captureAccessories(entry.id));
    const retailerCases=Array.isArray(retailers)?retailers:retailers.cases;
    if(retailerCases.length) browser=await browserPreparer({projectRoot,playwrightModule});
    for(const entry of retailerCases) {
      if(!['detection','shopping'].includes(entry.task))throw new Error('Invalid retailer task');
      const file=path.resolve(path.dirname(retailerManifest),entry.imagePath||entry.file||entry.image);
      const prepared=await browser.prepare(file,entry.task==='shopping');
      const {dataUrl,...evidence}=prepared;
      const preparedBytes=Buffer.from(dataUrl.split(',')[1],'base64');
      const uploaded=`uploads/${entry.id}.${dataUrl.startsWith('data:image/jpeg')?'jpg':dataUrl.startsWith('data:image/webp')?'webp':'png'}`;
      await fs.mkdir(path.join(out,'uploads'),{recursive:true});await fs.writeFile(path.join(out,uploaded),preparedBytes,{mode:0o600});
      preprocessing.push({id:entry.id,source:file,...evidence,uploadedPath:uploaded,uploadedSha256:sha256(preparedBytes),browser:browser.version,method:'Production prepareUploadImage executed in Chromium; production server path then applied'});
      const request=entry.task==='detection'?await harness.captureDetection(dataUrl):await harness.captureShopping(dataUrl,entry.notes||'',library);
      await add({id:entry.id,task:entry.task,split:entry.split,family:entry.family,timeoutMs:entry.task==='shopping'?120000:210000,sourceCaseId:entry.id,sourceProductFamily:entry.sourceProductFamily||entry.family,notes:entry.task==='shopping'?entry.notes||'':undefined},request);
    }
  } finally {await browser?.close();await harness.close();}
  const sourceHashes=Object.fromEntries(await Promise.all(SOURCE_FILES.map(async file=>[file,sha256(await fs.readFile(path.join(projectRoot,file)))])));
  const suite={version:1,outputCaps:{detection:16384,curation:16384,shopping:16384,scene:8192,accessories:8192},createdAt:new Date().toISOString(),kind:'Production middleware transport capture',snapshot:snapshotMetadata,inventory:library.map(({id,name,part,color,secondaryColor,tags})=>({id,name,part,color,secondaryColor,tags})),excludedPairs,sourceHashes,imageHashes,preprocessing,cases,parity:{transport:'All payloads captured at production /responses call; terminal mocked HTTP 400 prevents subsequent generation.',browser:'Actual production upload module in Chromium; server normalization unchanged.',credentials:'Dummy offline credential; no live API transport.',cache:'Frozen request fixtures; API caching remains provider-observable. Existing saved accessory suggestion cache omitted intentionally to exercise uncached suggestion task.'}};
  await fs.writeFile(path.join(out,'suite.json'),JSON.stringify(suite,null,2)+'\n',{flag:'wx',mode:0o600});
  await fs.writeFile(path.join(out,'suite.sha256'),sha256(await fs.readFile(path.join(out,'suite.json')))+'\n',{flag:'wx',mode:0o600});
  return {out,cases:cases.length,tasks:Object.fromEntries(['detection','curation','shopping','scene','accessories'].map(task=>[task,cases.filter(x=>x.task===task).length]))};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
  const options={};for(let i=2;i<process.argv.length;i+=2)options[process.argv[i].replace(/^--/,'').replace(/-([a-z])/g,(_,x)=>x.toUpperCase())]=process.argv[i+1];
  try{console.log(JSON.stringify(await prepareSuite(options),null,2));}catch(error){console.error(error.stack);process.exitCode=1;}
}
