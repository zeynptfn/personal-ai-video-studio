# Phase 3B — Cloud Run Jobs FFmpeg worker

İnceleme: 7 Kasım 2026. Kod ve testler hazırlandı; **Google Cloud kaynağı oluşturulmadı, API açılmadı, billing etkinleştirilmedi, cloud render başlatılmadı ve deploy yapılmadı**. Google hesabı/Free Trial uygunluğu bu ortamda doğrulanmadı. Windows'ta FFmpeg kurulu olması üretim yolunu değiştirmez.

## Karar ve maliyet değerlendirmesi

Cloud Run Jobs, tarayıcıdan bağımsız kısa CPU render için tercih edilen adaydır. Container tek işi tamamlayıp çıkar; Vercel yalnız koordinasyon yapar. Private Supabase Storage ve mevcut manifest/karakter/sahne ilişkileri korunur. **Kalıcı veya koşulsuz $0 garantisi doğrulanmadı; render varsayılan kapalıdır.**

| Aday | Uygunluk ve sınırlama | Değerlendirme |
| --- | --- | --- |
| Cloud Run Jobs | Billing hesabı gerekir. Instance-based hesaplanır; her task için en az 1 dakika. Jobs ücretsiz kotası 240.000 vCPU-saniye ve 450.000 GiB-saniye/ay, billing hesabında paylaşılır; bölge fiyatı önemlidir. İnternet çıkışı ayrıca ücretlenebilir. | Tercih edilen async container. Ücretsiz kota harcama kilidi değildir. |
| Google Free Trial | Uygun yeni kullanıcı için 90 gün / $300 kredi, yükseltilmemiş trial'da ücret alınmaması belgelenir; süre/kredi bitince kaynaklar durur. Daha önce trial veya ödeme geçmişi uygunluğu etkiler. Kart/kimlik doğrulaması gerekebilir. | Geçici test adayı; mevcut kullanıcının uygunluğu bilinmiyor. Paid hesaba upgrade yapılmayacak. |
| Compute Engine e2-micro | Free Tier belirli ABD bölgelerinde bir non-preemptible e2-micro, 30 GB standard persistent disk ve sınırlı egress sunar. Paid hesabın kapsam dışı kaynakları ücretlenir. Ağ/IP/disk seçimleri ayrıca incelenmeli. | VM yönetimi ve sürekli kaynak takibi gerektirir; free-only kilit yerine geçmez. |
| OCI Always Free | Güncel teklif toplam 2 ARM OCPU / 12 GB, home-region kapasitesi ve idle reclaim riski içerir. Yükseltilmemiş Free Tier ile paid tenancy farklıdır. | Alternatif; bu kullanıcı için hesap/kapasite doğrulanmadı. Önceki Phase 3 araştırması korunur. |

### Cloud Run spend cap: var, fakat $0 garantisi değil

Güncel Cloud Billing belgelerinde Cloud Run eligible service olarak yer alır. Scope bir proje + bir servis, dönem aylık; first-party müşteriler için, reseller hesapları kapsam dışında. Estimated gross maliyetler savings/credit olmadan değerlendirilir. **Enforcement anlık değildir ve gecikmedeki aşım kullanıcıya fatura edilir.** Caps ay başında sıfırlanıp hizmeti yeniden açabilir. Alerts-only budget cap değildir. `$0` hedefinin kabul edileceği veya ilk ücretli kullanımı atomik durduracağı doğrulanmadı.

Cloud Run belgesi Jobs için yeni execution'ların başlayamaması ve devam eden task'ların durması davranışını tarif eder; genel Billing belgesi in-flight kullanımın ücret biriktirebileceğini de belirtir. Bundan bir overshoot-free garanti çıkarılmadı. Cloud Run cap, Compute Engine VPC connector VM'lerini kapsamaz. Artifact Registry, Cloud Build, Secret Manager, Logging, ağ ve Supabase kotaları bağımsız incelenmelidir. Cap yokluğu/uygunsuzluğu sessizce bütçe alarmıyla ikame edilmez.

Registry'de ilk 0.5 GiB-ay kapsamı billing hesabında paylaşılır; image saklama, transfer ve isteğe bağlı scanning ek maliyet yaratabilir. Bu PR registry oluşturmaz, image push etmez veya scanning açmaz. Ağ için Cloud Run fiyat sayfasındaki 1 GiB Kuzey Amerika içi ücretsiz çıkış, Supabase başka kıtadaysa varsayılamaz. No VPC connector/NAT/load balancer/scheduler/PubSub eklendi.

## Sınırlar ve mimari

Cloud Run dokümanında 1 vCPU için 512 MiB–4 GiB, 2 vCPU için 512 MiB–8 GiB seçenekleri vardır; CPU/memory daha yukarı seçilebilir. Bu worker **1 vCPU / 2 GiB / 1 task / parallelism 1 / retries 0** ile sınırlandırılır. Provider task timeout 660s; worker bütün işlem için 600s, FFmpeg için 540s sınır koyar. Varsayılan 10 dakikalık timeout veya retry ayarlarına güvenilmez.

Cloud Run dosya sistemi geçicidir ve yazılan dosyalar RAM tüketir. `/tmp` için 256 MiB Memory volume; kaynak toplamı en fazla 180 MiB, çıktı 20 MiB, 8 klip/120s. Native prosesler temiz env ile, shell olmadan, decoder thread 1 / encoder thread 2 çalışır. 720×1280 hedef veya 360×640 preview seçilebilir. Yüksek çözünürlüklü/uzun girişlerde OOM/timeout olabilir; otomatik yeniden deneme yoktur.

```mermaid
sequenceDiagram
  participant B as Özel stüdyo
  participant V as Vercel koordinatörü
  participant D as Private Supabase SQL
  participant G as Cloud Run Jobs
  participant W as Ayrı worker
  participant S as Private Storage
  B->>V: Auth + kaydedilmiş proje/sürüm
  V->>D: Atomik enqueue, snapshot, bütçe ve barrier
  V->>G: WIF/OIDC; definition doğrula; tek run isteği
  G->>W: Tek task, sıfır retry
  W->>V: HMAC + dispatch eşleşmesiyle claim
  V->>D: Fenced lease + kalıcı rendering
  W->>V: Heartbeat / scope'lu input linki
  W->>S: Özel kaynakları indir
  W->>W: FFprobe + FFmpeg + çıktı doğrulama
  W->>S: Scope'lu PUT ile MP4 yükle
  W->>V: İmzalı completion raporu
  V->>S: HEAD size/MIME doğrula
  V->>D: completed + output asset
  B->>V: Sonradan gerçek durumu oku
```

- Tarayıcı encoding yapmaz, FFmpeg.wasm yoktur; Vercel FFmpeg çalıştırmaz. `worker/runtime` web uygulamasına import edilmez. Sunucu yalnız saf output rapor validator'ını kullanır.
- Standalone container HTTP portu açmaz. Giriş kaynağı private signed URL'den güvenli, boyut sınırlı stream olarak temp dosyasına indirilir; arbitrary URL, kullanıcı argümanı/filtergraph veya dosya adı FFmpeg'e verilmez.
- FFprobe format/stream/süre/çözünürlük/FPS/ses sınırları kontrol edilir. FFmpeg trim + timestamp reset + 24 fps normalize + pad/crop + sıralı concat uygular. Sessiz klip için silence, mute/volume, voice trim/offset ve mix/padding desteklenir. H.264/yuv420p + AAC/stereo/48 kHz + faststart MP4 çıkar.
- FFmpeg/FFprobe input protokolleri `file,pipe`, format allowlist sabittir; video dış dosya referansları kapalıdır. Proses env'inde token/anahtar yoktur, stderr medya metadata'sı loglanmaz. Bu bir işletim sistemi network namespace garantisi değildir; production'da Cloud Run sandbox ve güncel codec paketleri de gereklidir. Container reference testi ayrıca `--network none` ile geçti.
- Çıktı FFprobe ile codec, 9:16 boyut, süre ve size için tekrar kontrol edilir. Coordinator yalnız doğrulanmış worker raporu + server HEAD sonrası completed yazar. Coordinator codec'i yeniden decode etmez; worker güvenilen bileşendir.

## Kalıcı durum, sahiplik ve iptal

İkinci migration ayrı RLS-kapalı tablolar ekler: `studio_render_settings`, `studio_render_attempts`, `studio_worker_nonces`. Lease/dispatch UUID'leri, immutable manifest ve input snapshot **browser'a listelenen job tablosunda tutulmaz**. Job tablosuna sadece güvenli progress/phase ve execution adı eklenir. Browser rolüne worker RPC/table izni verilmez.

Mevcut tek-sahipli parolalı stüdyo modeli geçerlidir. Owner `STUDIO_CLOUD_OWNER_ID` üzerinden server'da belirlenir; istemci owner/path/endpoint seçemez. Render kaydedilmiş proje revizyonuna bağlanır. Aktif işin projesi değiştirilemez. Input'lar ready olmalı ve son signed PUT yetkisi + 30s geçmiş olmalıdır; böylece input snapshot sırasında aktif browser write linki bulunmaz. Kaynakları yükledikten sonra yaklaşık 5 dakika beklemek gerekebilir.

Transaction lock, tek aktif iş index'i, günde en fazla 3 / ayda en fazla 20 attempt ve 400 MiB storage rezervasyonu uygulanır. Bunlar provider billing-account genelini ölçmez; ücretsiz kota garantisi değildir. Her proje için tek execution attempt vardır. Yeni deneme açıkça yeni proje gerektirir; eski sonuçlar/başarısız kayıtlar silinmez.

- Worker claim yalnız doğru job + dispatch ile bir kez yapılır. 45s lease, 10s heartbeat, 600s deadline; bütün callback'ler fenced lease taşır.
- HMAC POST body/path/timestamp/nonce'a bağlıdır. 30s zaman penceresi ve DB unique nonce replay'i engeller. Worker endpoint'i parola cookie'si yerine bu ayrı kimliği kullanır; parola sahibi olmak callback imzalama yetkisi vermez.
- Queue start 5 dakikada doğrulanmazsa failed; heartbeat/deadline kaybında failed/unknown cancellation kodu. Status okuması reconciliation yapar; browser açık kalması gerekmez, provider timeout browser'dan bağımsızdır. Reconciliation görünür DB etiketini sonraki istekte günceller; cron eklenmedi.
- Google `jobs.run` tek kez çağrılır. Timeout/ağ hatası sonucu belirsizse tekrar gönderilmez. 15 dakikalık dispatch barrier ve claim'den itibaren en az 12 dakika barrier, belirsiz işten sonra yeni pahalı render'a geçilmesini sınırlar.
- Kullanıcı iptali önce kalıcı `cancel_requested` yazar. Bilinen execution için Google cancel çağrısı denenir. In-progress iş yalnız worker prosesinin durması onaylanınca cancelled olur. Provider/worker teyidi yoksa arayüz iptal istendi/teyitsiz failure gösterir; sahte durdu durumu üretilmez. Queue claim'den önce iptal edilirse kaynaklar işlenmez; yine de provider startup/minimum billing olabilir.
- Geç worker success, cancelled/expired lease ile reddedilir. Worker finally temp dosyalarını siler; zorla kapanmada Cloud Run ephemeral volume yok olur. Yarım/failed storage nesneleri otomatik arşiv silme yerine rezervasyonda kalır; Phase 3 cleanup talimatı uygulanır.
- Tamamlanan çıktı özel signed preview/download ile açılır ve karakter/sahne/sceneIds ilişkileriyle history kaydı yapılır. İmzalı linkler kalıcı history'ye yazılmaz. Kullanıcı indirdiğinde mevcut IndexedDB saklama yolu kullanılır. UI'ya dönüp projeyi açmak history kopyasını oluşturur; server'daki completed durumu browser'dan bağımsızdır.

## Default-off ve kimlik doğrulama

Üç ayrı etkinleştirme şartı vardır: Vercel render flag + en fazla 24 saatlik maliyet onayı, SQL'de en fazla 24 saatlik maliyet onayı, Cloud Run worker boot flag. Bunların hiçbiri billing lock değildir. Şartlar eksikse run API çağrısı yapılmaz. Bu görevde hiçbirine gerçek değer atanmadı.

Vercel→Google için `@vercel/oidc` ile güncel request token, Google STS ve 600s service-account impersonation kullanılır. Service-account JSON key veya kalıcı Google access token saklanmaz. WIF trust yalnız sizin Vercel team/project/environment claim'lerinize ve doğru audience/issuer'a bağlanmalıdır; public veya bütün preview'lara açık trust kurulmaz. Preview için ayrı düşük yetki/bütçe gerekir.

Invoker identity yalnız belirli Job için get/run-with-overrides/cancel yetkileri almalıdır (`run.jobs.get`, `run.jobs.run`, `run.jobs.runWithOverrides`, `run.executions.cancel` gerekli). Project Editor/Owner veya billing değiştirme yetkisi verilmez. Worker runtime identity invoker değildir; yalnız kendi isimli Secret Manager secret'ına erişmesi gerekebilir. Worker Supabase service-role veya S3 secret almaz; yalnız dar private transfer URL'leri alır.

`jobs.run` öncesinde deployed definition doğrulanır: 1 task, parallelism 1, retries 0, 660s timeout, tek `worker` container, CPU 1 / RAM 2Gi, digest-pinned image, boot flag true, 256Mi MEMORY scratch ve VPC connector olmaması. Eksik/tanınmayan alanlar fail-closed davranır. Bu kontrol Google hesabına karşı canlı test edilmedi; gerçek REST definition biçimi kontrolü geçmezse sınırlar gevşetilmeyip eşdeğer belgeli alan temsili incelenmelidir. Definition kontrolü ile admin değişikliği arasındaki yarış veya aynı billing hesabındaki diğer işler için sıfır ücret garantisi verilmez.

## Kurulum: yalnız açık kullanıcı onayından sonra

Aşağıdaki talimatlar **bu görevde uygulanmadı**. Önce hesabın billing/trial durumu, olası ücretler, spend-cap eligibility ve bütün yan servisler kullanıcıyla incelenmeli. Sadece “Google Cloud aday olabilir” demek provisioning veya execution onayı sayılmaz.

1. Ayrı Google projesi ve bölge planlayın; Supabase ile aradaki egress'i değerlendirin. Cloud Run, IAM/STS/Service Account Credentials, private Artifact Registry ve gerektiğinde Secret Manager API'leri için açık onay alın. Otomatik `gcloud services enable`, proje/billing açma veya paid upgrade script'i yoktur.
2. Billing → Budgets & alerts altında **Spend cap enforcement** desteğini kontrol edin; Cloud Run service ID `152E-C115-5142`, tek proje/servis, Monthly scope. Alerts-only seçmeyin. Gecikme/aşım riskini kabul edemiyorsanız burada durun ve render kapalı kalsın. Registry/secret/logging/egress maliyetleri ayrıca değerlendirilmelidir.
3. Mevcut private Supabase Free kurulumunu ve birinci migration'ı doğrulayın. İkinci migration `202611070002_render_worker.sql` dosyasını manuel inceleyip uygulayın. RLS/policy public erişime açılmamalı.
4. Container'ı geliştirme makinesinde veya onaylı build ortamında oluşturun; deployed studio bu makineyi kullanmaz. Cloud Run için Linux/amd64 hedefi kullanın:

   ```sh
   docker build --platform linux/amd64 -f worker/Dockerfile -t studio-ffmpeg:review .
   ```

   Yönetilen Codex proxy ortamında build-only public CA için `--secret id=proxy_ca,src=/etc/ssl/certs/ca-certificates.crt` gerekir. TLS doğrulamasını kapatmayın. Root `.dockerignore` sadece worker ve küçük ortak modülleri içerir; `.env`, kullanıcı medyası ve anahtarlar image'a alınmaz. Base image testte çözülen digest'e sabitlenmiştir; paket güncellemeleri sonrası testleri tekrarlayın.
5. Ağsız development testi:

   ```sh
   docker run --rm --network none --cpus 1 --memory 2g --pids-limit 96 --read-only \
     --cap-drop ALL --security-opt no-new-privileges \
     --tmpfs /tmp:rw,size=268435456,mode=1777 --entrypoint node \
     studio-ffmpeg:review worker/test/reference.test.mjs
   ```

6. **Push/deploy de açık onay gerektirir.** Onaydan sonra image'ı yalnız incelenmiş private registry'ye gönderin ve digest'i alın. `worker/deployment/cloud-run-job.yaml` şablonunda image, runtime identity, private coordinator origin, Supabase ref ve pinned secret version alanlarını doldurun. Başlangıç boot flag false kalır. Secret değerini dosyaya/komut geçmişine/GitHub'a yazmayın. Secret Manager kullanımı ve IAM ayrı incelenmelidir.
7. Onaydan sonra doldurulmuş şablon için `gcloud run jobs replace worker/deployment/cloud-run-job.yaml --project REVIEWED_PROJECT --region REVIEWED_REGION` kullanılabilir. Şablonda `--execute-now` yoktur; replace bir render başlatma izni değildir. Canlı job definition'ını tekrar inceleyin. No public invoker, sidecar, GPU, scheduler, VPC connector veya otomatik retry eklemeyin.
8. Vercel WIF kurulumu: resmi Vercel GCP rehberini izleyin; issuer/audience ve claim condition'ı **kendi** team/project/production environment'ınıza daraltın. SA impersonation sadece invoker SA'ya, invoker izinleri sadece ilgili Job'a verilsin. Hiçbir Google key chat'e veya repo'ya gönderilmez.
9. Vercel Settings → Environment Variables'a aşağıdaki isimleri server-only ekleyin. Production/Preview scope'larını ayırın. Yeni deploy yalnız sizin başlatmanızla yapılmalı. SQL'de `studio_render_settings` kaydına ve env'e aynı kısa (ör. 1 saat) risk onayı penceresi verin. Süreler otomatik uzatılmaz. Cloud Run boot flag yalnız ayrı execution onayından sonra true yapılmalı.
10. Önce read-only durum/definition doğrulaması; sonra **ayrı gerçek render onayı** ile küçük preview acceptance çalıştırın. Error varsa otomatik retry veya maliyet kontrollerini atlama yoktur.

### Ortam değişkeni isimleri

Vercel server-only: mevcut `STUDIO_PASSWORD`, `STUDIO_SESSION_SECRET`, `ENABLE_PAID_APIS=false`, private Supabase değişkenleri korunur. Yeni değişkenler:

| İsim | Amaç |
| --- | --- |
| `STUDIO_CLOUD_RENDER_ENABLED=false` | Varsayılan; açık kullanıcı onayı olmadan true yapılmaz |
| `STUDIO_RENDER_COST_APPROVAL_EXPIRES_AT` | ISO tarih, en fazla 24 saat; harcama garantisi değildir |
| `STUDIO_RENDER_WORKER_SECRET` | Ayrı en az 32 karakterli HMAC secret; yalnız Vercel + worker |
| `GCP_RENDER_PROJECT_ID`, `GCP_RENDER_PROJECT_NUMBER` | İncelenmiş tek proje |
| `GCP_RENDER_REGION`, `GCP_RENDER_JOB` | Tek bölge ve `studio-` ile başlayan job |
| `GCP_RENDER_WIF_POOL`, `GCP_RENDER_WIF_PROVIDER` | Daraltılmış WIF trust |
| `GCP_RENDER_INVOKER_NAME` | Bu projedeki invoker SA'nın kısa adı |

Vercel OIDC token'ı platform tarafından runtime'da sağlanır; elle access token konmaz. `NEXT_PUBLIC_` varyantı yoktur. Worker tarafı: `STUDIO_WORKER_EXECUTION_ENABLED=false`, `STUDIO_COORDINATOR_ORIGIN`, `STUDIO_STORAGE_PROJECT_REF`, HMAC secret. Job/dispatch ID'leri tek execution için server override'ından gelir; Cloud Run kendi `CLOUD_RUN_*` metadata'sını sağlar. App, bilinmeyen task/attempt veya lokal startup'ı reddeder.

Vercel: Hobby / Next.js / Node 24.x / Root `.`; install ve build komutları öncekiyle aynı. Coordinator maxDuration 60s, worker callback 30s; HTTP calls 6s. Bunlar render süresini taşımaz. Bu feature branch'in Git deployment'ı kapalıdır.

## Gerçek cloud kabul testi — henüz çalıştırılmadı

`scripts/cloud-render-acceptance.mjs` iki MP4 ve bir gerçek MP3/WAV/M4A alır (her biri ≤20 MiB). Görüntüleri ilk 1'er saniyeye trim eder, voice offset 0.25s ile 360×640 preview ister; bütün encoding Cloud Run worker'dadır. Windows geliştirme testi için Node 24 ve PATH içinde `ffprobe.exe` gerekir; production worker bunları kendi image içinde taşır. Script medya upload/download yapar; çıktı doğrulaması için **yerel FFprobe** kullanır; bu sadece development doğrulamasıdır ve deployed studio buna bağımlı değildir.

Önce bu üç dosyanın kullanımı ve **gerçek Google Cloud execution** kullanıcı tarafından açıkça onaylanmalıdır. Password'u chat'e/argümana yazmayın; özel process ortamında `STUDIO_SMOKE_PASSWORD` olarak sağlayın. Ayrıca `STUDIO_ACCEPT_CLOUD_RENDER_COSTS=YES` guard'ı gerekir. Bu guard onay alma sürecinin yerine geçmez.

```sh
node scripts/cloud-render-acceptance.mjs \
  --url https://personal-ai-video-studio-bice.vercel.app \
  --first /private/clip1.mp4 --second /private/clip2.mp4 --audio /private/voice.wav \
  --out work/cloud-acceptance
```

Script yok/kapalı onayla ağ isteği göndermez. Upload sonrası yazma linklerinin süresinin bitmesini bekler, tek render gönderir, gerçek DB durumunu izler; otomatik yeniden submit etmez. Monitor kapansa bile kabul edilmiş cloud task devam eder. Son MP4 ve token içermeyen execution receipt sadece ignored `work/` altına yazılır. Ardından Google Console'da aynı execution'ın tamamlandığını doğrulayın ve stüdyo preview/indirilen MP4'ü oynatın. Cloud tarafı execution kanıtı + playback olmadan kabul geçti denmez.

Bu görevde bu script çalıştırılmadı; Supabase canlı upload, WIF, Google definition/run/cancel ve gerçek cloud render henüz doğrulanmadı. Sadece Node/FFmpeg ve workspace container development testleri geçti.

## Test kanıtı ve kalan sınırlar

Komutlar: `npm run test:render`, `npm run test:render:reference`, mevcut `test:cloud`, `test:personal`, `test:hf-safety`, lint, production build ve Playwright. SQL testleri iki migration'ı gerçek Postgres motoru PGlite içinde yürütür. HMAC/WIF/Google API transfer testleri mock kullanır. Reference testi geçerli iki MP4/ses fixture üretip gerçek FFmpeg ile çıktıyı doğrular; sıralamayı decoded renklerle, mute/voice offset'i decoded sesle denetler. Tam worker lifecycle testi de gerçek FFmpeg kullanır ancak private HTTP transferleri mock'tur.

**Sonuç:** 61 unit/SQL/security/reference test geçti; Playwright 9 geçti, 1 gerçek GPU testi atlandı. Lint ve production build başarılı. Container içinde aynı 3 reference/lifecycle testi de geçti. Browser fixture sonuçları canlı provider kanıtı değildir.

Container build + bu testler ağsız, 1 CPU / 2 GiB ile yönetilen workspace'te çalıştırıldı; bu **Google Cloud acceptance değildir**. Geliştirme Windows FFmpeg'i veya Codex test makinesi production backend olarak kullanılmaz. HF generation'ın önceki ücretsiz/kredi kilitleri değişmedi.

Kalanlar: kullanıcı hesabı/plan/spend-cap incelemesi; kaynak/API/registry/secret kurulumu için onay; canlı private Supabase transferi; Vercel WIF ve Cloud Run REST integration; gerçek task/cancel/error testleri; browser kapalıyken cloud tamamlanma ve oynatılabilir indirilebilir MP4 kabul kanıtı. Sıfır ücret garantisi sağlanamıyorsa bütün render kapıları kapalı kalır.

## Birincil kaynaklar

- [Cloud Run Jobs fiyatı ve ücretsiz kota](https://cloud.google.com/run/pricing)
- [Google Free Trial/Free Tier ve billing uygunluğu](https://docs.cloud.google.com/free/docs/free-cloud-features)
- [Spend-cap eligibility, kapsam ve gecikme/overage](https://docs.cloud.google.com/billing/docs/how-to/budgets-spend-caps)
- [Cloud Run spend cap'in Jobs'a etkisi](https://docs.cloud.google.com/run/docs/configuring/billing-settings)
- [Job CPU seçenekleri](https://docs.cloud.google.com/run/docs/configuring/jobs/cpu)
- [Job memory ve RAM filesystem](https://docs.cloud.google.com/run/docs/configuring/jobs/memory-limits)
- [Container runtime ve Job lifecycle](https://docs.cloud.google.com/run/docs/container-contract)
- [Task timeout ve retry etkisi](https://docs.cloud.google.com/run/docs/configuring/task-timeout)
- [Cloud Run run API](https://docs.cloud.google.com/run/docs/reference/rest/v2/projects.locations.jobs/run)
- [Artifact Registry fiyatı](https://cloud.google.com/artifact-registry/pricing)
- [Vercel GCP OIDC/WIF kurulumu](https://vercel.com/docs/oidc/gcp)
- [OCI Always Free](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm)
