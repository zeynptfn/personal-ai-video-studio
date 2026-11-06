# Phase 2 — kimlikli ZeroGPU ve sıfır ücret güvenliği

## Karar

**Kimlikli otomatik üretim etkinleştirilmedi.** Kullanıcının zorunlu şartı, ücretsiz GPU süresi yetmezse gönderimin durması ve hiçbir ön ödemeli kredi/ücretli inference kullanılmamasıdır. İncelenen resmi API'lerde, kontrol ile gönderimi atomik yapan ve kredi kullanımını yasaklayan bir `free_only` / `max_cost=0` üretim sözleşmesi doğrulanamadı. Bu nedenle mevcut resmi-Space/manuel-import ve açıkça seçilen anonim yollar korunmuştur. Yeni bir kimlikli MP4 üretildiği iddia edilmez.

Bu karar, ücretsiz hesapların mutlaka ücretlendirildiği anlamına gelmez. HF belgeleri Free hesabı için dahil kota, PRO/Team/Enterprise için krediyle uzatma tarif eder. Sorun; bir kota okuması veya hesap planı kontrolünün sonraki istek için sağlayıcı tarafından uygulanan, atomik bir harcama yasağı olmamasıdır. Başka sekme/uygulama aynı kotayı kullanabilir; hesap planı, kredi durumu, Space kodu ve süre rezervasyonu değişebilir. Yerel kilit bu hesap genelindeki yarışı çözmez.

## Doğrulanan resmi davranışlar

| Konu | Kanıt ve sonuç |
| --- | --- |
| PAT kimlik doğrulaması | Resmi Gradio istemcisi sunucuda token kabul eder. HF API belgeleri token ile hesabın GPU kotasının tüketildiğini belirtir. Tarayıcıya token vermek gerekmez. Bu görevde gerçek PAT mevcut değildi; kimlikli çalışma testi yapılmadı. |
| Kota okuma | Resmi `HfApi.get_zero_gpu_quota()` uygulaması `GET https://huggingface.co/api/spaces/zero-gpu/quota` kullanır. Tokensız canlı istek 401 verdi. |
| Alanlar | Resmi Python sınıfı ham `base`, `current`, `resetsAt`, `overquotaUsed` alanlarını sırasıyla toplam GPU-saniye, kalan GPU-saniye, reset tarihi ve ücretli aşım kullanımı olarak ayrıştırır. CLI/SDK'daki `remaining` ve `resets_at` adları ham JSON anahtarları değildir. |
| Gerekli token yetkisi | Fine-grained token için `Billing > Read billing usage and payment method status`; OAuth için `read-billing` belgelenir. Bu izin kota okur; kredi kullanımını engelleyen izin değildir. |
| Reset | Belgelerde dahil kotanın ilk GPU kullanımından 24 saat sonra sıfırlandığı ve hiç kullanılmamış yeni pencerede reset alanının null olabileceği belirtilir. Uygulama reset zamanını tahmin ederek kota açmaz. |
| Kredi kullanımı | HF, uygun ücretli hesaplarda dahil kota sonrası ön ödemeli kredi kullanımının otomatik olabileceğini açıklar. `overquotaUsed=0` yalnızca geçmiş/snapshot bilgisidir; sonraki işin ücretsizliği kanıtı değildir. |
| LTX rezervasyonu | Resmi Space'in `8a42e93469c66b62d794b83a4233f5fc8439e2b5` sürümünde `get_duration` 7 saniyenin üstünde 75s, diğer durumlarda 60s; dekoratör `size="xlarge"`. HF belgeleri xlarge için 2× GPU-saniye tarif eder. 120/150 GPU-saniye preflight tahmini bu gözleme dayanır; kalıcı maliyet taahhüdü değildir. |

## Uygulanan kod — yalnızca güvenli preflight

`GET /api/personal/huggingface/preflight` giriş yapılmış özel stüdyo oturumu gerektirir. Middleware'e ek olarak handler içinde imzalı oturum tekrar doğrulanır. İsteğe bağlı `HF_TOKEN` yalnızca server-side `process.env` içinden okunur. Token, sabit HF kota URL'sine Authorization başlığıyla gider; yönlendirme reddedilir, sonuç cache'lenmez ve 6 saniyelik ağ sınırı kullanılır. Handler `runtime=nodejs`, `maxDuration=10` ile çalışır.

Bu endpoint **salt okunurdur**; Gradio, upload, generation, job veya ücretli model çağrısı yapmaz. Dönen `allowed` ve `authenticatedGenerationEnabled` her durumda `false` kalır:

- Token yok: `HF_TOKEN_NOT_CONFIGURED`; ağ çağrısı yapılmaz.
- Kota eksik, belirsiz, bozuk, tarihi geçmiş, tarih tipi yanlış veya aşım verisi eksik: `QUOTA_UNVERIFIED`.
- Ücretli aşım görülürse: `PAID_OVERQUOTA_DETECTED`.
- Kalan ücretsiz süre rezervasyon tahmininden düşükse: `INSUFFICIENT_FREE_QUOTA`.
- Kota yeterli görünse bile: `ATOMIC_FREE_ONLY_ENFORCEMENT_UNVERIFIED`.
- 401/403: `HF_AUTH_OR_BILLING_READ_SCOPE_REQUIRED`; diğer upstream/ağ/JSON sorunları: `QUOTA_UNAVAILABLE`.

POST aynı adreste açıkça 409 döner; token, istemci `enable` alanı veya herhangi bir bayrak üretimi açamaz. Eksik/yanlış stüdyo oturumu GET ve POST için 401'dir. Ham upstream yanıtı, hesap kimliği, token, URL parametresi veya exception mesajı döndürülmez/loglanmaz. Sadece beyaz listedeki kota sayıları ve reset zamanı özel yanıt içinde bulunur.

Bu preflight bir generation sağlayıcısı değildir ve mevcut UI'ya yeni bir "Generate" başarısı eklemez. Görsel, karakter, sahne ve mevcut geçmiş kayıtları değiştirilmedi. Yeterli kota gösterilmesi üretim izni değildir.

## Vercel ve asenkron tasarım sınırı

- İncelenen Vercel belgelerinde Hobby/Fluid compute için 300s çalışma, request/response için 4.5 MB sınırı bulunur. Güncel limitler deploy öncesi tekrar kontrol edilmelidir.
- Token'ı gizleyen bir upload proxy'si, 10 MB uygulama görsel sınırını otomatik olarak Vercel'in 4.5 MB sınırından geçiremez. Bölümlü/sınırlı yükleme veya güvenli ayrı asset katmanı gerekir. Bu görevde ücretli depolama eklenmedi.
- Resmi Gradio REST akışı gönderimden event ID alıp SSE sonucunu okumayı destekler. Ancak server-held token gereken bağlantıyı tarayıcı doğrudan izleyemez. Uzun SSE'yi tek Vercel fonksiyonunda tutmak uzun kuyrukları güvenilir yapmaz.
- Bir SDK job nesnesini Vercel process belleğinde tutup daha sonra aynı instance'a döneceğini varsaymak hatalıdır. Sağlayıcı destekli yeniden bağlanma/sonuç saklama ve kalıcı, güvenli iş durumu tasarımı doğrulanmalıdır. Geçici dosya veya sıcak instance gerektiren bir sistem eklenmedi.
- Uzak MP4 linkleri geçicidir. Kimlikli sonuç retrieval, token'ın dosya adresine veya tarayıcıya taşınmadığı ayrı bir doğrulama gerektirir. Önceki gerçek anonim SDK MP4 testi, kimlikli retrieval testi değildir.

Sıfır ücret koşulu çözülemediği için bu riskleri gizleyen kısmi bir upload/submit proxy'si yapılmadı. Hiçbir görüntü yüklenmedi ve bu aşamada gerçek GPU üretimi başlatılmadı.

## Özel ortam değişkenleri ve kurulum

Mevcut `STUDIO_PASSWORD`, `STUDIO_SESSION_SECRET` ve `ENABLE_PAID_APIS=false` korunur. Yeni zorunlu değişken yoktur. **Token paylaşmayın veya sohbete göndermeyin.**

PR incelenip siz deploy etmeye karar verdikten sonra yalnızca salt-okunur kota kontrolü isterseniz:

1. HF hesabınızda ayrı bir fine-grained PAT oluşturup yalnızca gereken billing-read yetkisini verin. Repo yazma, ücretli inference veya ödeme yönetimi izni bu preflight için gerekmez.
2. Vercel Project → Settings → Environment Variables altında **`HF_TOKEN`** adıyla özel/sensitive bir server değişkeni ekleyin; yalnızca istediğiniz ortamı seçin. Production ve Preview için ayrı kapsam kullanın.
3. `NEXT_PUBLIC_HF_TOKEN` oluşturmayın; token'ı kaynak, URL, log veya browser storage'a koymayın.
4. Değişken sonraki sizin başlattığınız deployment'ta etkili olur. Var olması kimlikli üretimi açmaz; yalnızca özel GET preflight hesabın kotasını okuyabilir.
5. Gerek duymuyorsanız `HF_TOKEN` boş kalsın. Mevcut anonim ve manuel iş akışları buna bağlı değildir.

Mevcut Vercel yapılandırması değişmedi:

| Ayar | Değer |
| --- | --- |
| Plan / Framework | Hobby / Next.js |
| Node.js | 24.x (`.nvmrc` ve `package.json` ile uyumlu) |
| Root Directory | `.` (repo kökü; `/personal` bir URL rotasıdır) |
| Install Command | `node scripts/prepare-web-workspaces.mjs && npm ci --ignore-scripts --include=dev` |
| Build Command | `npm run build:packages && npm run build` |
| Output Directory | Next.js varsayılanı |

Bu PR dalı için Vercel Git deployment'ı kapatıldı. Otomatik merge veya deploy yapılmaz.

## Test ve kalan engeller

- Sonuç: `npm run test:hf-safety` **7 geçti**, `npm run test:personal` **15 geçti**, lint ve production build başarılı. Playwright **4 geçti, 1 atlandı**; atlanan test gerçek GPU üretimidir. Tarayıcı derlemesinde `HF_TOKEN` bulunmadığı kontrol edildi.
- Yedi yeni maliyet/gizlilik testi: yeterli/yetersiz/negatif kota, süre çarpanı, eksik/bozuk/tarihi geçmiş alanlar, ücretli aşım, eksik token'da sıfır ağ isteği, sabit salt-okunur URL, redirect yasağı, hata redaksiyonu ve hiçbir durumda generation izni verilmemesi.
- Mevcut 15 provider/security testi korunur. Browser testine özel endpoint'in 401/200/409 kapıları eklendi; test sunucusunda gerçek HF token kullanımını önlemek için `HF_TOKEN` boşaltılır. Kota API test yanıtları mock'tur.
- Tokensız resmi kota ve whoami API'leri 401 döndü; bu yalnızca koruma davranışını doğrular. Gerçek token, hesap kotası ve kimlikli MP4 retrieval testi yapılmadı.
- TLS doğrulaması kapatılmadı; ücretli fallback, kredi kullanımı, yeni GPU altyapısı veya otomatik kota tekrarı eklenmedi.
- Açılması gerekenler: sağlayıcının ücretsiz bütçeyi atomik rezerve edip kredi kullanımını yasaklayan doğrulanmış sözleşmesi veya aynı güvenceyi veren belgeli hesap kısıtı; ardından güvenli async/upload/retrieval tasarımı ve yetkili gerçek test. Bu güvence olmadan authenticated automatic generation kapalı kalır.

## Birincil kaynaklar

- [ZeroGPU kota, xlarge çarpanı ve kredi uzatma](https://huggingface.co/docs/hub/spaces-zerogpu)
- [Resmi quota rehberi](https://huggingface.co/docs/huggingface_hub/main/guides/manage-spaces)
- [Resmi API metodu kaynağı](https://github.com/huggingface/huggingface_hub/blob/main/src/huggingface_hub/hf_api.py)
- [Ham quota alanlarının resmi parser'ı](https://github.com/huggingface/huggingface_hub/blob/main/src/huggingface_hub/_space_api.py)
- [PAT güvenliği](https://huggingface.co/docs/hub/security-tokens)
- [Gradio Space API ve token kota atfı](https://huggingface.co/docs/hub/spaces-api-endpoints)
- [İncelenen LTX kodu](https://huggingface.co/spaces/Lightricks/ltx-video-distilled/blob/8a42e93469c66b62d794b83a4233f5fc8439e2b5/app.py)
- [Vercel sınırları](https://vercel.com/docs/functions/limitations)
