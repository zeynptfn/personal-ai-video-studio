// Opt-in CLOUD acceptance, never executed automatically by tests/CI/deployment.
// This control script uploads/downloads; FFmpeg encoding runs only in Cloud Run.
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve,extname,join,relative,isAbsolute} from 'node:path';
import {randomUUID} from 'node:crypto';
import {setTimeout as wait} from 'node:timers/promises';
import {probe} from '../worker/runtime/ffmpeg.mjs';

export async function runAcceptance(env=process.env,{fetchImpl=fetch}={}) {
if(env.STUDIO_ACCEPT_CLOUD_RENDER_COSTS!=='YES')throw new Error('Explicit approval required: STUDIO_ACCEPT_CLOUD_RENDER_COSTS=YES. This may incur Google charges.');
const args=process.argv.slice(2),option=name=>{const index=args.indexOf(name);return index>=0?args[index+1]:undefined;};
const origin=new URL(option('--url')||'');
if(origin.protocol!=='https:'||!origin.hostname.endsWith('.vercel.app')||origin.pathname!=='/'||origin.search||origin.hash||origin.username||origin.password)throw new Error('Reviewed HTTPS Vercel origin required.');
if(!env.STUDIO_SMOKE_PASSWORD)throw new Error('Configure STUDIO_SMOKE_PASSWORD privately, never in command arguments.');
const output=resolve(option('--out')||'work/cloud-acceptance');
const within=relative(resolve('work'),output);
if(!within||within.startsWith('..')||isAbsolute(within))throw new Error('Output directory must be under ignored work/.');
const clips=[option('--first'),option('--second')],voice=option('--audio');
if(!clips.every(Boolean)||!voice)throw new Error('--first, --second and --audio are required.');
const files=[];
for(const [index,path] of [...clips,voice].entries()) {
  const bytes=await readFile(path),mime=index<2?'video/mp4':({'.wav':'audio/wav','.mp3':'audio/mpeg','.m4a':'audio/mp4'})[extname(path).toLowerCase()];
  if(!mime||bytes.length<1||bytes.length>20*1024*1024)throw new Error('Each input must be a supported file no larger than 20 MiB.');
  files.push({localId:randomUUID(),kind:index<2?'video':'audio',mime,blob:new Blob([bytes],{type:mime})});
}
let cookie='';
async function api(data) {
  const response=await fetchImpl(`${origin.origin}/api/personal/cloud`,{method:data?'POST':'GET',headers:{Cookie:cookie,Origin:origin.origin,...(data?{'Content-Type':'application/json'}:{})},...(data?{body:JSON.stringify(data)}:{}),redirect:'error',signal:AbortSignal.timeout(70000)});
  if(!response.ok)throw new Error(`Coordinator rejected request (${response.status}); do not automatically retry a render.`);return response.json();
}
function scoped(url){const parsed=new URL(url);if(parsed.protocol!=='https:'||!/^[a-z0-9]{20}\.storage\.supabase\.co$/.test(parsed.hostname))throw new Error('Unexpected storage origin.');return parsed.href;}
const login=await fetchImpl(`${origin.origin}/api/personal/session`,{method:'POST',headers:{Origin:origin.origin,'Content-Type':'application/json'},body:JSON.stringify({password:env.STUDIO_SMOKE_PASSWORD}),redirect:'error',signal:AbortSignal.timeout(15000)});
if(!login.ok)throw new Error('Studio authentication failed.');cookie=login.headers.getSetCookie().map(value=>value.split(';')[0]).join('; ');
if(!(await api()).renderEnabled)throw new Error('Render is disabled. Review setup and obtain approval; no generation was submitted.');
const projectId=randomUUID(),manifest={schemaVersion:1,title:'Cloud acceptance · two clips and voice',characterId:'',clips:files.slice(0,2).map(file=>({id:randomUUID(),assetId:file.localId,sceneId:'',trimStart:0,trimEnd:1,fit:'pad',volume:1,mute:true})),audio:{assetId:files[2].localId,offset:0.25,trimStart:0,volume:1},output:'preview'};
const saved=await api({action:'save',id:projectId,revision:0,manifest});
let settledAt=Date.now();
for(const file of files) {
  const {asset,ticket}=await api({action:'upload',projectId,asset:{localId:file.localId,kind:file.kind,mime:file.mime,size:file.blob.size}});
  const response=await fetchImpl(scoped(ticket.url),{method:'PUT',headers:ticket.headers,body:file.blob,redirect:'error',signal:AbortSignal.timeout(90000)});
  if(!response.ok)throw new Error('Direct private upload failed.');await api({action:'complete',id:asset.id});settledAt=Math.max(settledAt,Date.parse(asset.upload_expires_at)+31000);
}
process.stdout.write('Inputs uploaded; waiting for source write capabilities to expire. No render submitted yet.\n');
while(Date.now()<settledAt)await wait(Math.min(10000,settledAt-Date.now()));
const submitted=await api({action:'render',projectId,revision:saved.project.revision});
process.stdout.write(`Cloud render submitted: ${submitted.jobId}. Closing this monitor does not stop the cloud job.\n`);
const deadline=Date.now()+20*60*1000;let job;
while(Date.now()<deadline){const state=await api();job=state.jobs.find(item=>item.id===submitted.jobId);if(job&&['completed','failed','cancelled'].includes(job.status))break;await wait(10000);}
if(job?.status!=='completed'||!job.execution_name||!job.output_asset_id)throw new Error('Cloud completion was not verified. Inspect the durable job; never resubmit automatically.');
const {ticket}=await api({action:'read',id:job.output_asset_id});
const response=await fetchImpl(scoped(ticket.url),{redirect:'error',signal:AbortSignal.timeout(90000)});
if(!response.ok||Number(response.headers.get('content-length'))>20*1024*1024)throw new Error('Output download failed or exceeds limit.');
const bytes=Buffer.from(await response.arrayBuffer());if(bytes.length>20*1024*1024||bytes.length<1000||bytes.subarray(4,8).toString()!=='ftyp')throw new Error('Invalid MP4 output.');
await mkdir(output,{recursive:true});const path=join(output,'short.mp4');await writeFile(path,bytes,{mode:0o600});
// Local FFprobe is verification only. Encoding was requested from the cloud worker.
const report=await probe(path);if(report.width!==360||report.height!==640||report.videoCodec!=='h264'||report.audioCodec!=='aac'||Math.abs(report.duration-2)>0.15)throw new Error('Downloaded MP4 failed FFprobe verification.');
await writeFile(join(output,'receipt.json'),JSON.stringify({jobId:job.id,projectId,execution:job.execution_name,status:job.status,report},null,2),{mode:0o600});
process.stdout.write('Downloaded MP4 passed FFprobe verification. Verify execution in Google Console and play the file/studio preview to complete acceptance.\n');

}
if(import.meta.url===new URL(process.argv[1]||'',`file://${process.cwd()}/`).href) runAcceptance().catch(()=>{process.stderr.write(process.env.STUDIO_ACCEPT_CLOUD_RENDER_COSTS==='YES'?'CLOUD_ACCEPTANCE_FAILED: inspect private studio job status; do not automatically resubmit.\n':'CLOUD_ACCEPTANCE_DISABLED: explicit approval is required; no cloud request sent.\n');process.exitCode=1;});
