import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';

// Reuse the existing upstream demo as playback/upload input. Tests never encode
// or process video/audio, and this fixture is not proof of a cloud render.
const demoVideo = 'docs/assets/demo.mp4';

async function login(page) {
  await page.goto('/login');
  await page.getByLabel('Stüdyo parolası').fill(process.env.STUDIO_TEST_PASSWORD);
  await page.getByRole('button',{name:'Stüdyoya gir'}).click();
  await expect(page.getByRole('heading',{name:'Kontrol Paneli',exact:true})).toBeVisible();
  await expect(page.getByRole('link',{name:'İlk çekimi hazırla'})).toBeVisible();
  await page.screenshot({path:'work/browser-results/dashboard.png',fullPage:true});
}
const image = 'docs/assets/generated_example.webp';

test('private deployment redirects visitors and blocks paid proxies',async({page,request})=>{
  await page.goto('/personal');await expect(page).toHaveURL(/\/login$/);
  expect((await request.get('/api/personal/huggingface/preflight')).status()).toBe(401);
  expect((await request.post('/api/personal/huggingface/preflight')).status()).toBe(401);
  for (const path of ['/personal', '/personal/video', '/personal/characters', '/personal/scenes', '/personal/history', '/personal/settings', '/personal/shorts']) {
    const response=await request.get(path,{maxRedirects:0});
    expect(response.status(), `Private page: ${path}`).toBe(307);
    expect(new URL(response.headers().location).pathname).toBe('/login');
  }
  const privatePaths = [
    '/api/v1/wan2.2-image-to-video', '/api/v1/get_upload_url', '/api/v1/upload-binary',
    '/api/upload-binary', '/api/v1/history', '/api/v1/predictions/test/media',
    '/api/api/v1/wan2.2-image-to-video', '/api/agents/user/agents',
    '/api/app/test', '/api/workflow/test', '/api/v1/creative-agent/test',
  ];
  for (const path of privatePaths) {
    expect((await request.get(path)).status(), `Unauthenticated GET ${path}`).toBe(401);
    expect((await request.post(path,{data:{}})).status(), `Unauthenticated POST ${path}`).toBe(401);
  }
  const unauthenticated = await request.post('/api/personal/session', { headers: { Origin: 'https://example.invalid' }, data: { password: 'not-a-real-password' } });
  expect(unauthenticated.status()).toBe(403);
  await login(page);
  const preflight=await page.request.get('/api/personal/huggingface/preflight');
  expect(preflight.status()).toBe(200);
  expect(await preflight.json()).toMatchObject({allowed:false,reason:'HF_TOKEN_NOT_CONFIGURED',authenticatedGenerationEnabled:false});
  const submit=await page.request.post('/api/personal/huggingface/preflight',{data:{enable:true}});
  expect(submit.status()).toBe(409);expect(await submit.json()).toMatchObject({allowed:false,authenticatedGenerationEnabled:false});
  for (const path of privatePaths) expect((await page.request.post(path,{data:{}})).status(), `Paid proxy blocked: ${path}`).toBe(403);
  const sessionCookie=(await page.context().cookies()).find(cookie=>cookie.name==='personal_studio_session');
  expect(sessionCookie.httpOnly).toBe(true);expect(sessionCookie.secure).toBe(true);expect(sessionCookie.sameSite).toBe('Strict');
  await expect(page.locator('html')).toHaveAttribute('lang','tr');
  await page.getByRole('button',{name:'Oturumu kapat'}).click();
  await expect(page).toHaveURL(/\/login$/);
  await page.goto('/personal/history');await expect(page).toHaveURL(/\/login$/);
});

test('character, scene, audio and imported MP4 persist; manifest and download work',async({page})=>{
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await login(page);
  await page.getByRole('link',{name:'Karakter Stüdyo',exact:true}).click();
  await page.getByRole('button',{name:'Yeni karakter'}).click();
  await page.getByLabel('Karakter adı',{exact:true}).fill('Deniz');
  await page.getByLabel('Görünüm notları',{exact:true}).fill('Natural features, dark hair');
  await page.getByLabel('Tercih edilen görsel stil',{exact:true}).fill('Cinematic portrait');
  await page.getByLabel('Ana referans görseli',{exact:true}).setInputFiles(image);
  await page.getByRole('button',{name:'Karakteri kaydet'}).click();
  await expect(page.getByRole('heading',{name:'Deniz',exact:true})).toBeVisible();
  await page.reload();await expect(page.getByRole('heading',{name:'Deniz',exact:true})).toBeVisible();
  await page.getByRole('link',{name:'Sahne Stüdyo',exact:true}).click();
  await page.getByRole('button',{name:'Yeni sahne'}).click();
  await page.getByLabel('Sahne adı',{exact:true}).fill('Kıyıda bir sabah');
  await page.getByLabel('Karakter',{exact:true}).selectOption({label:'Deniz'});
  await page.getByLabel('Mekân',{exact:true}).fill('A quiet seaside');
  await page.getByLabel('Aksiyon',{exact:true}).fill('The character smiles gently');
  await page.getByLabel('Diyalog',{exact:true}).fill('Yeni bir gün, yeni bir hikâye.');
  const wav=Buffer.alloc(46);wav.write('RIFF',0);wav.writeUInt32LE(38,4);wav.write('WAVEfmt ',8);wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);wav.writeUInt32LE(8000,24);wav.writeUInt32LE(16000,28);wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);wav.write('data',36);wav.writeUInt32LE(2,40);
  await page.getByLabel('Ses ekle · MP3 / WAV / M4A · en fazla 30 MB',{exact:true}).setInputFiles({name:'voice.wav',mimeType:'audio/wav',buffer:wav});
  await expect(page.locator('audio')).toBeVisible();
  await page.getByRole('button',{name:'Sahneyi kaydet'}).click();
  await expect(page.getByRole('heading',{name:'Kıyıda bir sabah'})).toBeVisible();
  const exported=page.waitForEvent('download');await page.getByRole('button',{name:'JSON dışa aktar'}).click();
  const manifest=JSON.parse(await readFile(await (await exported).path(),'utf8'));
  expect(manifest.scenes[0].character.name).toBe('Deniz');expect(manifest.scenes[0].audioId).toBeTruthy();
  await page.getByRole('link',{name:'Bu sahneyi üret'}).click();
  await expect(page.getByLabel('Üretim yolu',{exact:true})).toHaveValue('official');
  await expect(page.getByRole('link',{name:'Resmi Space’te hesabımla üret'})).toHaveAttribute('href','https://huggingface.co/spaces/Lightricks/ltx-video-distilled');
  await expect(page.getByRole('button',{name:'Ücretsiz kotayla üret'})).toHaveCount(0);
  await expect(page.getByLabel('Hareket açıklaması',{exact:true})).toHaveValue(/quiet seaside/);
  await expect(page.locator('img[alt="Başlangıç karesi"]')).toBeVisible();
  await page.getByLabel('MP4 içe aktar',{exact:true}).setInputFiles(demoVideo);
  await expect(page.getByText('İçe aktarıldı',{exact:true})).toBeVisible();
  await expect(page.locator('video')).toBeVisible();
  await expect.poll(()=>page.locator('video').evaluate(video=>video.readyState>=1 && video.duration>0)).toBe(true);
  const downloaded=page.waitForEvent('download');await page.getByRole('button',{name:'MP4 indir ve sakla'}).click();
  const bytes=await readFile(await (await downloaded).path());expect(bytes.subarray(4,8).toString()).toBe('ftyp');
  await page.reload();await expect(page.getByText('İçe aktarıldı',{exact:true})).toBeVisible();
  await page.getByRole('link',{name:'Üretim Geçmişi',exact:true}).click();
  await expect(page.getByText('Manuel MP4',{exact:true})).toBeVisible();
  await page.setViewportSize({width:390,height:844});await page.getByRole('button',{name:'Gezinme menüsünü aç'}).click();
  await expect(page.getByRole('navigation',{name:'Stüdyo gezinmesi'})).toBeVisible();
  await page.getByRole('link',{name:'Karakter Stüdyo',exact:true}).click();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.screenshot({path:'work/browser-results/mobile-characters.png',fullPage:true});
  expect(errors).toEqual([]);
});

test('model controls reflect capabilities and invalid import is rejected',async({page})=>{
  await login(page);await page.goto('/personal/video');
  await expect(page.getByLabel('Görüntü oranı',{exact:true})).toBeVisible();
  await page.getByLabel('Üretim yolu',{exact:true}).selectOption('anonymous');
  await expect(page.getByRole('button',{name:'Ücretsiz kotayla üret'})).toBeVisible();
  await page.getByLabel('Video motoru',{exact:true}).selectOption('wan');
  await expect(page.getByLabel('Görüntü oranı',{exact:true})).toHaveCount(0);
  await expect(page.getByLabel('Kalite',{exact:true})).toHaveCount(0);
  await expect(page.getByRole('option',{name:/MuAPI/})).toBeDisabled();
  await page.reload();await expect(page.getByLabel('Video motoru',{exact:true})).toHaveValue('wan');
  await page.getByLabel('MP4 içe aktar',{exact:true}).setInputFiles({name:'fake.mp4',mimeType:'video/mp4',buffer:Buffer.from('not an MP4')});
  await expect(page.getByRole('alert').filter({hasText:'Geçerli bir MP4'})).toBeVisible();
});

test('reloading pending jobs marks them interrupted without auto-retry',async({page})=>{
  await login(page);
  await page.evaluate(async()=>{
    const database=await new Promise((resolve,reject)=>{const req=indexedDB.open('personal-cloud-studio',1);req.onsuccess=()=>resolve(req.result);req.onerror=reject;});
    await new Promise((resolve,reject)=>{const tx=database.transaction('jobs','readwrite');tx.objectStore('jobs').put({id:'pending-fixture',createdAt:Date.now(),status:'queued',providerId:'ltx',prompt:'Test pending job',origin:'generated'});tx.oncomplete=resolve;tx.onerror=reject;});database.close();
  });
  await page.goto('/personal/history');await page.reload();
  await expect(page.getByText('Bağlantı kesildi',{exact:true}).first()).toBeVisible();
  await expect(page.getByText(/Uzak iş bitmiş olabilir/)).toBeVisible();
});

test('optional real browser LTX generation downloads an actual MP4',async({page})=>{
  test.skip(process.env.STUDIO_LIVE_TEST!=='1','External GPU test is opt-in and consumes the anonymous free quota.');
  test.setTimeout(240000);
  await login(page);await page.goto('/personal/video');
  await page.getByLabel('Üretim yolu',{exact:true}).selectOption('anonymous');
  await page.getByLabel('Karakter / sahne görseli seç',{exact:true}).setInputFiles(image);
  await page.getByLabel('Hareket açıklaması',{exact:true}).fill('Gentle natural motion, steady camera, the subject blinks softly.');
  await page.getByLabel('Süre',{exact:true}).selectOption('1');
  await page.getByRole('checkbox').check();
  await page.getByRole('button',{name:'Ücretsiz kotayla üret'}).click();
  const finalStatus=page.locator('.ps-preview-card .ps-status');
  await expect(finalStatus).toHaveText(/Tamamlandı|Başarısız/,{timeout:180000});
  await expect(finalStatus,await page.locator('.ps-preview-card').innerText()).toHaveText('Tamamlandı');
  const downloaded=page.waitForEvent('download');await page.getByRole('button',{name:'MP4 indir ve sakla'}).click();
  const bytes=await readFile(await (await downloaded).path());expect(bytes.length).toBeGreaterThan(1000);expect(bytes.subarray(4,8).toString()).toBe('ftyp');
  await page.screenshot({path:'work/browser-results/live-ltx.png',fullPage:true});
});


test('cloud coordinator requires a session and origin; rendering stays blocked without free infrastructure',async({page,request})=>{
  expect((await request.get('/api/personal/cloud')).status()).toBe(401);
  expect((await request.post('/api/personal/cloud',{data:{action:'render'}})).status()).toBe(401);
  await login(page);
  const state=await page.request.get('/api/personal/cloud');
  expect(state.status()).toBe(200);expect(await state.json()).toMatchObject({storageReady:false,renderEnabled:false,projects:[],jobs:[]});
  expect((await page.request.post('/api/personal/cloud',{headers:{Origin:'https://example.invalid'},data:{action:'render'}})).status()).toBe(403);
  const headers={Origin:'http://127.0.0.1:3210'};
  const blocked=await page.request.post('/api/personal/cloud',{headers,data:{action:'render',enable:true,free:true}});
  expect(blocked.status()).toBe(409);expect((await blocked.json()).renderEnabled).toBe(false);
  expect((await page.request.post('/api/personal/cloud',{headers,data:{action:'save'}})).status()).toBe(503);
  expect((await page.request.post('/api/personal/cloud',{headers,data:{action:'save',oversized:'x'.repeat(33000)}})).status()).toBe(413);
});

test('Shorts timeline edits two saved clips and voice metadata without encoding or silent uploads',async({page})=>{
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  const storageRequests=[];page.on('request',request=>{if(request.url().includes('.supabase.co'))storageRequests.push(request.url());});
  await login(page);
  await page.goto('/personal/video');
  const mp4=await readFile(demoVideo);
  await page.getByLabel('MP4 içe aktar',{exact:true}).setInputFiles({name:'clip-one.mp4',mimeType:'video/mp4',buffer:mp4});
  await expect(page.getByText('İçe aktarıldı',{exact:true})).toBeVisible();
  await page.getByLabel('MP4 içe aktar',{exact:true}).setInputFiles({name:'clip-two.mp4',mimeType:'video/mp4',buffer:mp4});
  await expect(page.locator('video')).toBeVisible();
  // Metadata fixtures use the existing IndexedDB stores. This does not process media.
  await page.evaluate(async()=>{
    const db=await new Promise(resolve=>{const req=indexedDB.open('personal-cloud-studio',1);req.onsuccess=()=>resolve(req.result);});
    await new Promise((resolve,reject)=>{
      const tx=db.transaction(['characters','scenes','assets'],'readwrite');
      tx.objectStore('characters').put({id:'30000000-0000-4000-8000-000000000001',name:'Deniz Shorts'});
      tx.objectStore('scenes').put({id:'30000000-0000-4000-8000-000000000002',title:'Short sahnesi'});
      const bytes=new Uint8Array(46);const view=new DataView(bytes.buffer);const text=(at,value)=>{for(let i=0;i<value.length;i++)bytes[at+i]=value.charCodeAt(i);};
      text(0,'RIFF');view.setUint32(4,38,true);text(8,'WAVEfmt ');view.setUint32(16,16,true);view.setUint16(20,1,true);view.setUint16(22,1,true);view.setUint32(24,8000,true);view.setUint32(28,16000,true);view.setUint16(32,2,true);view.setUint16(34,16,true);text(36,'data');view.setUint32(40,2,true);
      tx.objectStore('assets').put({id:'30000000-0000-4000-8000-000000000003',name:'ElevenLabs voice.wav',type:'audio/wav',size:46,blob:new Blob([bytes],{type:'audio/wav'})});
      tx.oncomplete=resolve;tx.onerror=reject;
    });db.close();
  });
  await page.goto('/personal/shorts');
  await expect(page.getByRole('heading',{name:'Shorts Zaman Çizelgesi',exact:true})).toBeVisible();
  await page.getByLabel('Short adı',{exact:true}).fill('Deniz cloud Short');
  await page.getByLabel('Short karakteri',{exact:true}).selectOption({label:'Deniz Shorts'});
  await page.getByLabel('Kayıtlı klip',{exact:true}).selectOption({label:'clip-one.mp4'});await page.getByRole('button',{name:'Klibi ekle',exact:true}).click();
  await page.getByLabel('Kayıtlı klip',{exact:true}).selectOption({label:'clip-two.mp4'});await page.getByRole('button',{name:'Klibi ekle',exact:true}).click();
  await page.getByLabel('Klip 1 bitiş (sn)',{exact:true}).fill('2');
  await page.getByLabel('Klip 1 sahne',{exact:true}).selectOption({label:'Short sahnesi'});
  await page.getByRole('button',{name:'Klip 2 yukarı',exact:true}).click();
  await expect(page.getByLabel('Klip 2 bitiş (sn)',{exact:true})).toHaveValue('2');
  await page.getByLabel('Klip 1 sesini kapat',{exact:true}).check();
  await page.getByLabel('ElevenLabs / kayıtlı ses',{exact:true}).selectOption({label:'ElevenLabs voice.wav'});
  await page.getByLabel('Ses başlangıcı · zaman çizelgesi (sn)',{exact:true}).fill('0.5');
  await page.getByRole('button',{name:'Taslağı yerel kaydet',exact:true}).click();
  await expect(page.getByRole('alert').filter({hasText:'Buluta gönderilmedi'})).toBeVisible();
  await expect(page.getByRole('button',{name:'Bulutta Render Al',exact:true})).toBeDisabled();
  await expect(page.getByRole('button',{name:'Seçili dosyaları özel buluta yükle',exact:true})).toBeDisabled();
  await expect(page.getByText('Bu proje için bulutta kayıtlı iş yok.',{exact:true})).toBeVisible();
  await page.reload();await expect(page.getByLabel('Short adı',{exact:true})).toHaveValue('Deniz cloud Short');
  await expect(page.getByLabel('Klip 1 sesini kapat',{exact:true})).toBeChecked();
  await expect(page.getByLabel('Klip 2 sahne',{exact:true})).toHaveValue('30000000-0000-4000-8000-000000000002');
  await expect(page.getByLabel('Ses başlangıcı · zaman çizelgesi (sn)',{exact:true})).toHaveValue('0.5');
  await expect.poll(()=>page.locator('video').first().evaluate(video=>video.readyState>=1 && video.duration>0)).toBe(true);
  await page.setViewportSize({width:390,height:844});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await expect(page.getByRole('navigation',{name:'Stüdyo gezinmesi'})).not.toBeInViewport();
  await page.screenshot({path:'work/browser-results/shorts-mobile.png',fullPage:true});
  expect(storageRequests).toEqual([]);expect(errors).toEqual([]);
});

test('worker endpoint rejects browser sessions and forged callbacks',async({page,request})=>{
  expect((await request.post('/api/personal/cloud/worker',{data:{action:'claim'}})).status()).toBe(401);
  await login(page);
  expect((await page.request.post('/api/personal/cloud/worker',{headers:{'X-Studio-Signature':'a'.repeat(64)},data:{action:'complete'}})).status()).toBe(401);
});

test('fixture cloud cancellation remains requested until a confirmed terminal status is read',async({page})=>{
  await login(page);
  const projectId='70000000-0000-4000-8000-000000000091',jobId='70000000-0000-4000-8000-000000000092';
  let status='rendering';
  const manifest={schemaVersion:1,title:'Cloud status fixture',characterId:'',clips:[],audio:null,output:'preview'};
  await page.route('**/api/personal/cloud',async route=>{
    if(route.request().method()==='POST'){expect(route.request().postDataJSON().action).toBe('cancel-render');return route.fulfill({json:{cancelRequested:true,message:'İptal istendi. Worker durması henüz doğrulanmadı.'}});}
    return route.fulfill({json:{storageReady:true,renderEnabled:false,projects:[{id:projectId,revision:1,manifest}],assets:[],jobs:[{id:jobId,project_id:projectId,status,progress:0.45,phase:'encoding'}]}});
  });
  await page.goto('/personal/shorts');await page.getByLabel('Kayıtlı Short',{exact:true}).selectOption(projectId);
  await expect(page.getByRole('progressbar')).toHaveAttribute('value','0.45');
  await page.getByRole('button',{name:'Bulut işini iptal et',exact:true}).click();
  await expect(page.getByRole('alert').filter({hasText:'İptal istendi'})).toBeVisible();
  await expect(page.getByText('Bulutta işleniyor',{exact:true})).toBeVisible();
  status='cancelled';await page.getByRole('button',{name:'Bulut durumunu yenile',exact:true}).click();
  await expect(page.getByText('İptal edildi',{exact:true})).toBeVisible();
  await expect(page.getByRole('button',{name:'Bulut işini iptal et',exact:true})).toHaveCount(0);
});

test('fixture completed cloud output is previewed and saved to history without persisting signed URLs',async({page})=>{
  await login(page);
  const projectId='71000000-0000-4000-8000-000000000091',jobId='71000000-0000-4000-8000-000000000092',outputId='71000000-0000-4000-8000-000000000093';
  const signed='https://aaaaaaaaaaaaaaaaaaaa.storage.supabase.co/output.mp4?fixture-private-link=expires';
  const mp4=await readFile(demoVideo);
  await page.route('https://aaaaaaaaaaaaaaaaaaaa.storage.supabase.co/**',route=>route.fulfill({body:mp4,contentType:'video/mp4',headers:{'Content-Length':String(mp4.length)}}));
  await page.route('**/api/personal/cloud',route=>{
    if(route.request().method()==='POST'){expect(route.request().postDataJSON()).toEqual({action:'read',id:outputId});return route.fulfill({json:{ticket:{url:signed,expiresIn:120}}});}
    return route.fulfill({json:{storageReady:true,renderEnabled:false,projects:[{id:projectId,revision:1,manifest:{schemaVersion:1,title:'Cloud completed fixture',characterId:'',clips:[],audio:null,output:'preview'}}],assets:[],jobs:[{id:jobId,project_id:projectId,status:'completed',progress:1,output_asset_id:outputId,updated_at:new Date().toISOString()}]}});
  });
  await page.goto('/personal/shorts');await page.getByLabel('Kayıtlı Short',{exact:true}).selectOption(projectId);
  await expect(page.locator('video')).toBeVisible();await expect(page.getByText('Tamamlandı',{exact:true})).toBeVisible();
  await page.goto('/personal/history');await expect(page.getByText(/Cloud Run FFmpeg/)).toBeVisible();
  const downloaded=page.waitForEvent('download');await page.getByRole('button',{name:'MP4 indir ve sakla',exact:true}).click();
  expect((await readFile(await (await downloaded).path())).subarray(4,8).toString()).toBe('ftyp');
  await expect(page.getByText('Video bu tarayıcıya kaydedildi.',{exact:true})).toBeVisible();
  const history=await page.evaluate(async()=>{
    const db=await new Promise(resolve=>{const request=indexedDB.open('personal-cloud-studio',1);request.onsuccess=()=>resolve(request.result);});
    const jobs=await new Promise(resolve=>{const request=db.transaction('jobs').objectStore('jobs').getAll();request.onsuccess=()=>resolve(request.result);});db.close();return jobs;
  });
  expect(JSON.stringify(history)).not.toContain('fixture-private-link');expect(history.find(job=>job.id===jobId).cloudAssetId).toBe(outputId);
});
