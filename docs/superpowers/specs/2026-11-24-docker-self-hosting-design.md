# Docker sunucusunda Workshop ve OpenAI uyumlu model bağlantısı

24 Kasım 2026 · Tasarım önerisi

Barış’ın seçtiği dağıtım iki uygulama imajından oluşuyor. İşletmeci `web` ve `workshop` servislerini ayrı ayrı build edip çalıştırıyor. Kullanıcı mevcut model sunucusunun OpenAI uyumlu API kökünü ve sunulan modelin adını Workshop’a veriyor. Model sunucusunun yazılımını, donanımını ve sürümünü kendi işletmecisi yönetiyor. vLLM bu sözleşmeyi sağlayabilen sunuculardan biri. Gelecekte bir şirket içi Azure entegrasyonu gündeme geldiğinde kendi operasyonel gereksinimlerine göre değerlendirilecek.

## Değerlendirilen servis sınırları

| Yaklaşım | İşletmeye etkisi | Karar |
| --- | --- | --- |
| Arayüz ve çekirdek tek imaj | Tek komutla başlar. Arayüz değişikliği çekirdeğin de dağıtılmasını gerektirir. | En az kurulum adımı isteyenler için düşünüldü. |
| Web ve Workshop ayrı imajlar | Arayüz ve çekirdek bağımsız derlenir. Çalışma alanları ve bağlayıcılar mevcut Worker RPC bağlantılarını kullanır. | Barış bunu seçti. |
| Her bağlayıcı ayrı servis | Bağlayıcılar bağımsız güncellenir. Çağrılarda taşınan yetkiler ve kalıcı RPC referansları için süreçler arası taşıma gerekir. | Ayrı yaşam döngüsüne ihtiyaç duyan kritik iş akışları için ileride değerlendirilecek. |

## Kurulum ve veri

- **Web** derlenmiş Workshop arayüzünü sunar. Halka açılan tek uygulama portu burada olur. `/api`, `/gatekeeper/` ve `/blueprint-screenshot` yolları mevcut Router’a gider. WebSocket yükseltmesi, akış, özgün istek yolu ve herkese açık adres korunur. SPA iç sayfaları doğrudan açılabilir.
- **Workshop** aynı Docker ağında çalışan çekirdeği, Router’ı ve etkin gatekeeper Worker’larını içerir. Mevcut sürümün Worker Loader, facet, RPC ve onay mekanizmaları kullanılır. Geliştirme sunucusundaki dosya izleyicileri ve her açılışta derleme üretim yoluna taşınmaz. Bağımlılıklar imaj oluşturulurken kilit dosyasıyla kurulur. Başlatma Cloudflare hesabı veya model hizmetinin hazır olmasını gerektirmez.
- **Tek Docker sunucusu, bir Workshop veri yazıcısı** ilk dağıtım modelidir. SQLite tabanlı Durable Object’ler, KV alanları, R2 nesneleri ve bunları yeniden açmak için gereken kararlı namespace kimlikleri bir adlandırılmış volume ile birlikte korunur. Yeni imaj aynı veriye bağlanabilir. Yedeklemek için Workshop durdurulur, volume’un tamamı kopyalanır. Geri yükleme ayrı bir volume’da sınanır.
- **İşletme kılavuzu** repo kökünden ayrı ayrı çalıştırılan iki `docker build` komutunu, kullanıcı tanımlı Docker ağını, volume’u, iki `docker run` komutunu, güncellemeyi ve geri yüklemeyi gösterir. İlk kurulum örneği web portunu loopback’e bağlar. İşletmeci kendi kullanıcı adını `ADMINS` ayarına yazar ve o hesabı yerleşik parola akışıyla açar. Ardından mevcut TLS ters vekili üzerinden yayın yapabilir. Harici URL, OAuth dönüşlerini de belirler.
- **Platform hedefi** Linux Docker Engine üzerinde `amd64` ve `arm64` sunuculardır. Kilit dosyası iki mimari için de workerd paketini içeriyor. Her hedefte imajın build edilmesi ve açılış testi ayrı kaydedilir. Kılavuz gerçek donanımda ve emülasyonda alınan sonuçları belirtir. Harici model hizmetini kullanan iki uygulama imajı CPU ile çalışır. [Platform paketleri](../../../pnpm-lock.yaml)

## Model bağlantısı

Workshop’ın doğrudan model ekleme formunda **OpenAI uyumlu** seçeneği sunulur. Zorunlu alanlar API kökü ve model kimliğidir. Anahtar isteğe bağlıdır. Örneğin `https://inference.example.net/team/v1` adresi `https://inference.example.net/team/v1/chat/completions` yoluna gider. Sondaki eğik çizgi aynı sonucu verir. Model adı sunucuda kayıtlı takma ad olabilir. Bağlam ve çıktı sınırları için mevcut alanlar kullanılır. Akışlı yanıt, araç çağrısı ve araç sonucuyla devam eden ikinci tur aynı seçili bağlantıdan geçer. Endpoint kullanılabilirlik hatalarını kullanıcı sohbetinde görebilir. Yeniden deneme kullanıcının seçtiği endpoint’e gider.

Anahtar kullanıcıya ait kayıtlı sır olarak mevcut mekanizmadan geçer. Boş bırakıldığında Authorization başlığı gönderilmez. Adres değiştiğinde önceki sır yeni adrese taşınmaz. Özel ağdaki model için işletmeci Workshop’a erişilebilecek API köklerini açıkça tanımlar. Bu izin yalnız model istemcisinin seçili hedefe yaptığı çıkarım isteği içindir. Yönlendirme başka bir hedefe anahtar taşıyamaz. Gadget kodunun, genel web aracının ve diğer kullanıcı bağlantılarının ağ yetkisi genişlemez. Genel HTTPS uçları için doğrudan model bağlantısındaki mevcut genel ağ politikası uygulanır.

Model sağlayıcı kimliği ortak API’ye, formdaki seçeneklere ve çekirdeğin doğrudan sağlayıcı seçimine eklenir. Uygulama mevcut Chat Completions akışını kullanır. Bir Cloudflare AI Gateway’in yönettiği katalog yalnız kendi desteklediği sağlayıcıları sunar. Self-host kurulumu yerleşik parola girişi ve doğrudan model yoluyla başlar. Aynı endpoint’i sunan bir yazılım bu sözleşmeyle bağlanabilir. Kullanıcının model keşfi için ayrıca bir katalog sunması gerekmez.

## Çalışma zamanı ve entegrasyonlar

Teknik öneri, deponun kilitlediği workerd sürümünü ve derlenmiş Worker modüllerini paketlemek. Durable Object’ler yerel diske yazılır. KV ve R2 için çekirdeğin beklediği binding davranışlarını sağlayan disk destekli uygulamalar aynı Workshop servisine bağlanır. Hazır uyumlu uygulamalar tercih edilir. İlk uygulama adımı izole bir Docker ağında gerçek çekirdekle bir şablonun yazılıp tekrar okunmasını, bir facet’te gadget çalışmasını ve soğuk açılışı sınar. Bu sonuçlar, runtime paketlemesinin kabul koşuludur. [Bağlayıcılar ve depolama](../../../packages/workshop-backend/cloudflare.config.ts) · [workerd yapılandırma şeması](https://github.com/cloudflare/workerd/blob/main/src/workerd/server/workerd.capnp)

İlk sürümün yerel entegrasyon kabulü **Context Library** ve **Scheduled Tasks** için yapılır. Bir kullanıcı bağlam koleksiyonu oluşturup ajanına okutabilir ve zamanlanmış bir işi çalıştırabilir. Mevcut vendor entegrasyonlarında etkinleştirme noktası Workshop’ın Worker binding listesidir. Yerel gereksinimleri karşılanan bağlayıcılar aynı imajdan etkinleştirilebilir, gerektiğinde işletmeci kendi hizmet bilgilerini verir. Kılavuz bunları, doğrulanan akışları ve ek bir platform servisi gerektiren işlemleri listeler. Harici bir vendor hesabıyla canlı işlem ilk teslimin önkoşulları dışında kalır. Browser Rendering ile dışa aktarma ve Workers AI üzerinden belge dönüştürme ayrı özelliklerdir. Eksik bir binding nedeniyle kullanılamayan özellik gerekçesiyle gösterilir.

Gelecekteki bir entegrasyon ayrı kimlik bilgileriyle yönetiliyor, kurum ağına özel erişim gerektiriyor veya bağımsız güncelleme ve hata yalıtımı istiyorsa ayrı servis adayıdır. Örneğin şirket içi Azure’a erişecek bir servis kurum kimliğini kendi tarafında tutabilir. Workshop tarafındaki küçük gatekeeper kullanıcı yetkisini, onayı ve denetim kaydını korur. İlk sürümün kapsamı iki uygulama imajı ve standart model protokolüdür. Güven modeli, işletmecinin denetimindeki kişisel veya güvenilen ekip kurulumudur. Birbirine güvenmeyen tarafların kodunu aynı makinede barındırmak ek dış yalıtım gerektirir. [workerd güvenlik modeli](https://github.com/cloudflare/workerd)

## Teslimi kanıtlayan senaryolar

1. Temiz bir Linux Docker Engine’de iki imaj depodan ayrı ayrı build edilir. Belgelenen komutlarla boş volume’dan arayüz, yerleşik giriş ve WebSocket oturumu açılır. Çalışma anında paket indirilmez.
2. Aynı Docker ağındaki OpenAI uyumlu test endpoint’i bir metin ve bir araç çağrısını akışla döner. Workshop aracı çalıştırır ve sonucunu ikinci istekte aynı endpoint’e yollar. Sunulan model adı, özel yol öneki, anahtarlı ve anahtarsız istekler denetlenir. Endpoint kapalıyken arayüz ve mevcut veriler açılabilmelidir. Gerçek bir servisle yapılan kontrol ayrı raporlanır.
3. Bir şablondan oluşturulan gadget kaydedilir. Workshop container’ı yeniden yaratıldığında aynı hesap, sohbet ve gadget açılır. Zamanlanmış bir iş yeniden başlatmadan sonra çalışır. Durdurularak alınan yedek yeni volume’da açılır.
4. Özel model adresine ayrılan bağlantıdan onaylı hedefe erişim ve genel web aracının o hedefe erişim sınırı test edilir. Dışarıdan yalnız web portu yayımlanır. Üretim koşullarındaki CLI yönetici sınırı ve mevcut sağlayıcı kayıtlarının davranışı regresyon testlerine dahil edilir.

HTTP sunucusu seçimi, dosya yerleşimi, imaj katmanları ve depolama bağdaştırıcılarının kesin seçimi uygulayıcıya bırakılır. Çalışma zamanı ve kalıcılık doğrulamaları bu seçimleri sınırlar. [Kaynak incelemesi](../../docker-self-hosting-review.tr.md)
