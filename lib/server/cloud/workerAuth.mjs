import { createHash, createHmac, timingSafeEqual, randomUUID } from 'node:crypto';
export const WORKER_PATH='/api/personal/cloud/worker';
export function signWorker(body,secret,{now=Date.now(),nonce=randomUUID()}={}) {
  const time=String(Math.floor(now/1000));
  const digest=createHash('sha256').update(body).digest('hex');
  const signature=createHmac('sha256',secret).update(`POST\n${WORKER_PATH}\n${time}\n${nonce}\n${digest}`).digest('hex');
  return {'X-Studio-Time':time,'X-Studio-Nonce':nonce,'X-Studio-Signature':signature};
}
export function verifyWorker(body,headers,secret,now=Date.now()) {
  if(typeof secret!=='string'||secret.length<32) return false;
  const time=headers.get('x-studio-time'),nonce=headers.get('x-studio-nonce'),signature=headers.get('x-studio-signature');
  if(!/^\d{10}$/.test(time||'')||Math.abs(now/1000-Number(time))>30||!/^[a-f0-9-]{36}$/.test(nonce||'')||!/^[a-f0-9]{64}$/.test(signature||'')) return false;
  const expected=signWorker(body,secret,{now:Number(time)*1000,nonce})['X-Studio-Signature'];
  return timingSafeEqual(Buffer.from(signature,'hex'),Buffer.from(expected,'hex'));
}
