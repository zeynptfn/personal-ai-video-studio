'use client';
import { useEffect, useState } from 'react';
import { useStudio } from './StudioContext';
import { storage } from '@/lib/personal/storage.mjs';
import { validateTimeline, validateCloudAsset, newTimeline, moveClip, RENDER_LABELS } from '@/lib/personal/cloud/timeline.mjs';
import { cloudRequest, uploadPrivateFile } from '@/lib/personal/cloud/client.mjs';
import { AssetImage, Field, Empty, MediaPreview } from './Shared';

const createProject = () => ({ id: crypto.randomUUID(), manifest: newTimeline(), revision: 0 });
const LOCAL_KEY = 'shorts-projects-v1';
export default function TimelinePanel() {
  const studio = useStudio();
  const [project,setProject] = useState(null), [drafts,setDrafts] = useState([]), [assets,setAssets] = useState([]);
  const [cloud,setCloud] = useState({ storageReady: false, renderEnabled: false, projects: [], assets: [], jobs: [] });
  const [busy,setBusy] = useState(''), [message,setMessage] = useState(''), [clipJob,setClipJob] = useState('');
  const [consent,setConsent] = useState(false), [includeReferences,setIncludeReferences] = useState(false), [preview,setPreview] = useState(null);
  useEffect(() => {
    let alive = true;
    Promise.all([storage('preferences','get',LOCAL_KEY),storage('assets','getAll')]).then(([saved,files]) => {
      if (!alive) return;
      setDrafts(saved?.items || []); setProject(saved?.items?.[0] || createProject()); setAssets(files);
    }).catch(() => { if (alive) setMessage('Yerel taslaklar okunamadı. Tarayıcı depolamasını kontrol edin.'); });
    return () => { alive = false; };
  }, []);
  async function refresh() {
    try { setCloud(await cloudRequest()); } catch (error) { setMessage(error.message); setCloud(previous => ({ ...previous, storageReady: false })); }
  }
  useEffect(() => {
    let alive = true;
    const check = () => { if (document.visibilityState === 'visible') cloudRequest().then(value => { if (alive) setCloud(value); }).catch(() => { if (alive) setMessage('Bulut durumu okunamadı. Son durumun güncel olduğu doğrulanmadı.'); }); };
    check(); document.addEventListener('visibilitychange',check);
    return () => { alive = false; document.removeEventListener('visibilitychange',check); };
  }, []);
  const activeJob = cloud.jobs?.find(job => job.project_id === project?.id);
  const completedOutput=activeJob?.status==='completed'?activeJob.output_asset_id:null;
  useEffect(() => {
    if(!completedOutput || !project) return;
    let alive=true;
    cloudRequest({action:'read',id:completedOutput}).then(({ticket})=>{if(alive)setPreview(ticket.url);}).catch(()=>{if(alive)setMessage('Tamamlanan çıktı bağlantısı alınamadı; yeniden açın.');});
    if(!studio.jobs.some(item=>item.id===activeJob.id)) studio.put('jobs',{id:activeJob.id,createdAt:Date.parse(activeJob.updated_at),status:'completed',origin:'cloud-render',providerId:'cloud-run',cloudAssetId:completedOutput,cloudProjectId:project.id,characterId:project.manifest.characterId,sceneId:project.manifest.clips[0]?.sceneId || '',sceneIds:project.manifest.clips.map(clip=>clip.sceneId).filter(Boolean),prompt:project.manifest.title}).catch(()=>{if(alive)setMessage('Cloud çıktı hazır; bu tarayıcının geçmişine kaydedilemedi.');});
    return ()=>{alive=false;};
  // Read URLs remain only in component memory, never in persisted history.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[completedOutput]);
  const hasActiveJob = cloud.jobs?.some(job => ['queued','rendering'].includes(job.status));
  useEffect(() => {
    if (!hasActiveJob) return;
    const timer = setInterval(() => { cloudRequest().then(setCloud).catch(() => setMessage('İş durumu okunamadı; yeniden deneyin.')); },15000);
    return () => clearInterval(timer);
  }, [hasActiveJob]);
  async function persist(next) {
    const items = [next,...drafts.filter(item => item.id !== next.id)];
    if (items.length > 20) throw new Error('Yerel Short sınırı 20. Mevcut projelerin üzerine yazılmadı.');
    await storage('preferences','put',{ id: LOCAL_KEY, items }); setDrafts(items);
  }
  async function run(label, operation) {
    setBusy(label); setMessage('');
    try { await operation(); } catch (error) { setMessage(error.message); await refresh(); } finally { setBusy(''); }
  }
  function edit(key,value) { setProject(previous => ({ ...previous,manifest: { ...previous.manifest,[key]: value } })); }
  function editClip(id,key,value) { edit('clips',project.manifest.clips.map(clip => clip.id === id ? { ...clip,[key]: value } : clip)); }
  function selectProject(next) { setProject(next); setPreview(null); setConsent(false); setIncludeReferences(false); }
  async function saveRemote() {
    const manifest = validateTimeline(project.manifest);
    const { project: saved } = await cloudRequest({ action: 'save',id: project.id,revision: project.revision,manifest });
    const next = { id: saved.id,revision: saved.revision,manifest: saved.manifest };
    setProject(next); await persist(next); return next;
  }
  async function upload() {
    if (!consent) throw new Error('Yalnızca seçili dosyaları yüklemek için onay verin.');
    const manifest = validateTimeline(project.manifest);
    const ids = new Set(manifest.clips.map(clip => clip.assetId));
    if (manifest.audio) ids.add(manifest.audio.assetId);
    if (includeReferences) {
      const character = studio.characters.find(item => item.id === manifest.characterId);
      if (character?.mainImageId) ids.add(character.mainImageId);
      manifest.clips.forEach(clip => { const scene = studio.scenes.find(item => item.id === clip.sceneId); if (scene?.referenceId) ids.add(scene.referenceId); });
    }
    const files = [...ids].map(id => {
      const asset = assets.find(item => item.id === id); if (!asset?.blob) throw new Error('Seçilen yerel dosya bulunamadı.');
      const kind = asset.type.startsWith('video/') ? 'video' : asset.type.startsWith('audio/') ? 'audio' : 'image';
      validateCloudAsset({ localId: id,kind,mime: asset.type,size: asset.size }); return { asset,kind };
    });
    const saved = await saveRemote();
    for (const { asset,kind } of files) {
      if (!cloud.assets?.some(item => item.project_id === saved.id && item.local_id === asset.id && item.state === 'ready')) await uploadPrivateFile(saved.id,asset.id,asset.blob,kind);
    }
    await uploadPrivateFile(saved.id,saved.id,new Blob([JSON.stringify(manifest)],{type:'application/json'}),'manifest');
    await refresh(); setMessage('Seçilen dosyalar ve proje manifesti özel depolamaya yüklendi. Render başlatılmadı.'); setConsent(false);
  }
  if (!project) return <Empty>Zaman çizelgesi açılıyor…</Empty>;
  const manifest = project.manifest;
  const videoJobs = studio.jobs.filter(job => job.assetId && ['completed','imported'].includes(job.status));
  const character = studio.characters.find(item => item.id === manifest.characterId);
  const total = manifest.clips.reduce((sum,clip) => sum+clip.trimEnd-clip.trimStart,0);
  const availableProjects = [...drafts,...(cloud.projects || []).filter(item => !drafts.some(local => local.id === item.id)).map(item => ({ id:item.id,manifest:item.manifest,revision:item.revision }))];
  return <div className="ps-stack">
    <section className="ps-card ps-stack" aria-label="Bulut hazırlığı"><h2>Shorts · Bulut zaman çizelgesi</h2>
      <p>Kesme, sıralama ve ses ayarları proje talimatlarıdır. Bu tarayıcı video veya ses işlemez. Yerel kaydet yalnızca bu cihazdaki taslağı saklar.</p>
      <p role="status">{cloud.storageReady ? 'Özel bulut depolaması hazır.' : 'Özel bulut depolaması yapılandırılmadı veya erişilemiyor.'} {cloud.renderEnabled ? 'Cloud Run için süreli maliyet onayı var; ücretsiz çalışma garanti edilmez.' : 'Cloud Run render kapalı; kullanıcı maliyet onayı ve worker kurulumu gerekli.'}</p>
      <p className="ps-muted">Yükleme açık onay gerektirir. Yükleme tamamlanana kadar sekme açık kalmalı. Onaylı Cloud Run işi başladıktan sonra tarayıcı kapalıyken devam eder. Render kapalıysa iş gönderilmez.</p>
      <div className="ps-actions"><button className="ps-button" disabled={!!busy} onClick={() => run('yenile',refresh)}>Bulut durumunu yenile</button><button className="ps-button" disabled={!!busy} onClick={() => run('yeni',async() => { await persist(project); selectProject(createProject()); })}>Yeni Short</button></div>
      {!!availableProjects.length && <Field label="Kayıtlı Short"><select value={project.id} disabled={!!busy} onChange={event => run('aç',async() => { const next = availableProjects.find(item => item.id === event.target.value); if (next) { await persist(project); selectProject(next); } })}><option value={project.id}>{manifest.title}</option>{availableProjects.filter(item => item.id !== project.id).map(item => <option key={item.id} value={item.id}>{item.manifest.title}{item.revision ? ' · bulut kaydı' : ' · yerel'}</option>)}</select></Field>}
    </section>
    {message && <p role="alert" className="ps-notice">{message}</p>}
    <fieldset className="ps-timeline-fields ps-stack" disabled={!!busy}>
      <section className="ps-card ps-stack"><div className="ps-form-grid"><Field label="Short adı"><input maxLength={100} value={manifest.title} onChange={event => edit('title',event.target.value)}/></Field>
        <Field label="Short karakteri"><select value={manifest.characterId} onChange={event => edit('characterId',event.target.value)}><option value="">Karakter seçilmedi</option>{studio.characters.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></Field>
        <Field label="Çıktı"><select value={manifest.output} onChange={event => edit('output',event.target.value)}><option value="preview">Önizleme · 360×640</option><option value="720p">Short · 720×1280</option></select></Field></div>
        {character && <AssetImage id={character.mainImageId} alt="Short karakteri" className="ps-scene-image"/>}
        <div className="ps-actions"><Field label="Kayıtlı klip"><select value={clipJob} onChange={event => setClipJob(event.target.value)}><option value="">Klip seçin</option>{videoJobs.map(job => <option key={job.id} value={job.id}>{job.prompt?.slice(0,60) || 'MP4'}</option>)}</select></Field>
          <button type="button" className="ps-button" disabled={!clipJob || manifest.clips.length >= 8} onClick={() => { const job = videoJobs.find(item => item.id === clipJob); if (job) edit('clips',[...manifest.clips,{id:crypto.randomUUID(),assetId:job.assetId,sceneId:job.sceneId || '',trimStart:0,trimEnd:1,fit:'pad',volume:1,mute:false}]); }}>Klibi ekle</button></div>
        {!videoJobs.length && <p>Önce AI Video Stüdyo veya Üretim Geçmişi’nde bir MP4 saklayın. Geçici bağlantılar otomatik yüklenmez.</p>}
      </section>
      <ol className="ps-timeline-list">{manifest.clips.map((clip,index) => <li key={clip.id} className="ps-card ps-stack" aria-label={`Klip ${index+1}`}>
        <div className="ps-card-heading"><h2>Klip {index+1}</h2><div className="ps-actions"><button className="ps-button" aria-label={`Klip ${index+1} yukarı`} disabled={!index} onClick={() => edit('clips',moveClip(manifest.clips,index,-1))}>↑</button><button className="ps-button" aria-label={`Klip ${index+1} aşağı`} disabled={index === manifest.clips.length-1} onClick={() => edit('clips',moveClip(manifest.clips,index,1))}>↓</button><button className="ps-button danger" aria-label={`Klip ${index+1} kaldır`} onClick={() => edit('clips',manifest.clips.filter(item => item.id !== clip.id))}>Kaldır</button></div></div>
        <div className="ps-timeline-clip"><MediaPreview job={{ assetId: clip.assetId }}/><div className="ps-form-grid">
          <Field label={`Klip ${index+1} başlangıç (sn)`}><input type="number" min="0" max="600" step="0.1" value={clip.trimStart} onChange={event => editClip(clip.id,'trimStart',Number(event.target.value))}/></Field>
          <Field label={`Klip ${index+1} bitiş (sn)`}><input type="number" min="0.1" max="600" step="0.1" value={clip.trimEnd} onChange={event => editClip(clip.id,'trimEnd',Number(event.target.value))}/></Field>
          <Field label={`Klip ${index+1} sahne`}><select value={clip.sceneId} onChange={event => editClip(clip.id,'sceneId',event.target.value)}><option value="">Sahneye bağlı değil</option>{studio.scenes.map(scene => <option key={scene.id} value={scene.id}>{scene.title}</option>)}</select></Field>
          <Field label={`Klip ${index+1} kadraj`}><select value={clip.fit} onChange={event => editClip(clip.id,'fit',event.target.value)}><option value="pad">Sığdır · kenar dolgusu</option><option value="crop">Doldur · merkezden kırp</option></select></Field>
          <Field label={`Klip ${index+1} ses düzeyi`}><input type="number" min="0" max="2" step="0.1" value={clip.volume} onChange={event => editClip(clip.id,'volume',Number(event.target.value))}/></Field>
          <label className="ps-check"><input type="checkbox" checked={clip.mute} onChange={event => editClip(clip.id,'mute',event.target.checked)}/>Klip {index+1} sesini kapat</label>
        </div></div>
      </li>)}</ol>
      <section className="ps-card ps-stack"><h2>Ses ve teslim</h2><div className="ps-form-grid">
        <Field label="ElevenLabs / kayıtlı ses"><select value={manifest.audio?.assetId || ''} onChange={event => edit('audio',event.target.value ? {assetId:event.target.value,offset:0,trimStart:0,volume:1} : null)}><option value="">Ses seçilmedi</option>{assets.filter(asset => asset.type.startsWith('audio/')).map(asset => <option key={asset.id} value={asset.id}>{asset.name}</option>)}</select></Field>
        {manifest.audio && <><Field label="Ses başlangıcı · zaman çizelgesi (sn)"><input type="number" min="0" max="120" step="0.1" value={manifest.audio.offset} onChange={event => edit('audio',{...manifest.audio,offset:Number(event.target.value)})}/></Field>
          <Field label="Ses dosyası başlangıcı (sn)"><input type="number" min="0" max="600" step="0.1" value={manifest.audio.trimStart} onChange={event => edit('audio',{...manifest.audio,trimStart:Number(event.target.value)})}/></Field>
          <Field label="Dış ses düzeyi"><input type="number" min="0" max="2" step="0.1" value={manifest.audio.volume} onChange={event => edit('audio',{...manifest.audio,volume:Number(event.target.value)})}/></Field></>}
      </div><p>ElevenLabs API çağrısı yapılmaz. Sahne Stüdyo’da yüklediğiniz ses dosyaları seçilebilir. Dudak senkronizasyonu uygulanmaz.</p>
        <p>Planlanan süre: {Number.isFinite(total) ? total.toFixed(1) : '—'} sn · en fazla 120 sn, 8 klip. Gerçek süre ve formatlar ileride cloud FFprobe ile doğrulanmalı.</p>
        <div className="ps-actions"><button className="ps-button" onClick={() => run('yerel',async() => { const next = {...project,manifest:validateTimeline(manifest)}; await persist(next); setMessage('Taslak bu tarayıcıda kaydedildi. Buluta gönderilmedi.'); })}>Taslağı yerel kaydet</button>
          <button className="ps-button" disabled={!cloud.storageReady} onClick={() => run('kaydet',async() => { await saveRemote(); await refresh(); setMessage('Proje talimatları bulutta kaydedildi. Medya otomatik yüklenmedi.'); })}>Proje talimatlarını buluta kaydet</button></div>
        <label className="ps-check"><input type="checkbox" checked={includeReferences} onChange={event => setIncludeReferences(event.target.checked)}/>Seçili karakterin ana görselini ve klip sahnelerinin referanslarını da yükle</label>
        <label className="ps-check"><input type="checkbox" checked={consent} onChange={event => setConsent(event.target.checked)}/>Yalnızca bu projede seçtiğim dosyaları özel buluta yüklemeyi onaylıyorum.</label>
        <div className="ps-actions"><button className="ps-button" disabled={!cloud.storageReady || !consent} onClick={() => run('yükle',upload)}>Seçili dosyaları özel buluta yükle</button><button className="ps-button primary" disabled={!cloud.renderEnabled || project.revision < 1} title="Cloud Run maliyet onayı gerekir; ücretsiz çalışma garanti edilmez" onClick={() => run('render',async() => { const saved=await saveRemote(); const result=await cloudRequest({action:'render',projectId:saved.id,revision:saved.revision}); setMessage(result.message); await refresh(); })}>Bulutta Render Al</button></div>
        <small>Dosya başına video/ses 20 MB, görsel 10 MB. Büyük dosyalar tarayıcıda sıkıştırılmaz. {busy && 'İşlem sürüyor…'}</small>
      </section>
    </fieldset>
    <section className="ps-card ps-stack"><h2>Buluttaki iş durumu</h2><p>{activeJob ? RENDER_LABELS[activeJob.status] || 'Durum doğrulanamadı' : 'Bu proje için bulutta kayıtlı iş yok.'}</p>
      {activeJob?.status === 'rendering' && <><progress max="1" value={activeJob.progress || 0}/><small>{({downloading:'Dosyalar indiriliyor',encoding:'FFmpeg işliyor',uploading:'Çıktı yükleniyor',verifying:'Çıktı doğrulanıyor'})[activeJob.phase] || 'Worker çalışıyor'} · %{Math.round((activeJob.progress || 0)*100)}</small></>}
      {activeJob && ['queued','rendering'].includes(activeJob.status) && <button className="ps-button danger" disabled={!!busy} onClick={() => run('iptal',async() => { const result=await cloudRequest({action:'cancel-render',jobId:activeJob.id}); setMessage(result.message); await refresh(); })}>Bulut işini iptal et</button>}
      {activeJob?.error_code && <p className="ps-error">İş başarısız. Yarım yüklemeyi yeniden denemek için projeyi açıkça kaydedip dosyaları tekrar seçin. Güvenli hata kodu: {activeJob.error_code}</p>}
      {!!cloud.assets?.filter(asset => asset.project_id === project.id).length && <ul className="ps-stack">{cloud.assets.filter(asset => asset.project_id === project.id).map(asset => <li key={asset.id}>{asset.kind} · {(asset.size/1024/1024).toFixed(2)} MB · {asset.state === 'ready' ? 'Yüklendi' : asset.state === 'failed' ? 'Yükleme onayı süresi doldu' : 'Yükleme bekleniyor'} <button className="ps-button" disabled={asset.state !== 'ready' || !!busy} onClick={() => run('indir',async() => { const { ticket } = await cloudRequest({action:'read',id:asset.id}); if (asset.kind === 'video') setPreview(ticket.url); else window.open(ticket.url,'_blank','noopener,noreferrer'); })}>{asset.kind === 'video' ? 'MP4 önizle / indir' : 'Özel dosyayı indir'}</button></li>)}</ul>}
      {preview && <><video src={preview} controls playsInline preload="metadata" className="ps-video"/><a className="ps-button" href={preview} target="_blank" rel="noreferrer">MP4 indir</a><small>Özel bağlantı 2 dakika geçerlidir. Süresi dolarsa yeniden açın.</small></>}
    </section>
  </div>;
}
