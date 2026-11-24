# Docker sunucusunda çalıştırma

Repo kökünden Docker BuildKit ile iki Linux imajı oluşturulur. `web` arayüzü ve WebSocket ters vekilini, `workshop` çekirdeği ve gatekeeper Worker’larını çalıştırır. Model, ağ üzerinden eriştiğin ayrı bir servistir. Bu iki imaj CPU üzerinde çalışır. Kurulum tek Docker sunucusu ve her veri volume’u için tek Workshop işlemi kullanır.

```sh
docker build --target web -t dockerflare/web:local .
docker build --target workshop -t dockerflare/workshop:local .
docker network create dockerflare
docker volume create dockerflare-data
```

İmajları başka bir makinede de hazırlayabilirsin. Hedefe göre build komutuna `--platform linux/amd64` veya `--platform linux/arm64` ekle. JavaScript paketleri build makinesinin işlemcisinde üretilir, Workshop imajına hedef platformun workerd binary’si girer. İki etiketi `docker save -o dockerflare.tar dockerflare/web:local dockerflare/workshop:local` ile taşıyabilir ve hedefte `docker load -i dockerflare.tar` ile yükleyebilirsin.

## İlk açılış

Sunucuda yalnızca işletmecinin okuyabildiği bir dosyaya aşağıdaki ayarları yaz. Dosyayı repo dışında tut. Docker’ın `--env-file` biçiminde JSON değerlerinin etrafına kabuk tırnağı eklenmez. `PUBLIC_BASE_URL` için kullanıcıların tarayıcıda açacağı kalıcı origin’i seç. Context koleksiyonlarının paylaşım alanı da bu origin’e bağlıdır.

```dotenv
PUBLIC_BASE_URL=http://localhost:8080
ADMINS=["baris"]
SELF_HOSTED_MODEL_BASE_URLS=["http://inference:8000/v1"]
GATEKEEPERS=context,scheduler
```

```sh
docker run -d --name workshop --restart unless-stopped \
  --network dockerflare --env-file "$HOME/workshop.env" \
  --mount source=dockerflare-data,target=/data dockerflare/workshop:local

docker run -d --name dockerflare-web --restart unless-stopped \
  --network dockerflare -p 127.0.0.1:8080:8080 dockerflare/web:local
```

Web servisi Docker DNS üzerinden `workshop:8787` adına bağlanır. Farklı bir container adı kullanırsan ona `--network-alias workshop` ver. Tarayıcıdan `http://localhost:8080` adresini aç. İlk kayıtta `ADMINS` içinde verdiğin kullanıcı adını kendin al. Uzak sunucuda ilk kurulum için `ssh -L 8080:127.0.0.1:8080 sunucum` kullanılabilir. Başka kullanıcılara açarken TLS ters vekilini web portuna yönlendir. Bu vekil özgün `Host` değerini korumalı ve WebSocket yükseltmesine izin vermeli. Dış adresi `PUBLIC_BASE_URL` olarak kullan. Yönetim panelinden yeni kayıtları açıp kapatabilirsin.

Bu dağıtım kişisel sunucular ve güvenilen ekipler içindir. Birbirine güvenmeyen müşterilerin kodunu barındırırken workerd’in önerdiği ek süreç veya sanal makine yalıtımını ayrıca tasarlamak gerekir. [workerd güvenlik açıklaması](https://github.com/cloudflare/workerd)

```sh
curl -fsS http://localhost:8080/healthz
curl -fsS http://localhost:8080/api/version
docker logs --tail 30 workshop
```

İlk istek web servisini, ikinci istek web ile çekirdek arasındaki hattı kontrol eder. Başlangıçta model sunucusu çevrimdışı olsa da hesaplar ve mevcut çalışma alanları açılır.

## Modelini bağlama

1. Workshop’ta **AI providers → Add provider** yolunu aç ve **Select Model** listesinden **OpenAI-compatible endpoint** seç. **API root URL** alanına örneğin `http://inference:8000/v1` veya `https://models.example.org/team/v1` gir. Workshop bu köke `/chat/completions` ekler.
2. Model alanına sunucunun kabul ettiği kimliği veya takma adı gir. Sunucu Bearer anahtarı istiyorsa **API Token** alanını doldur. Sunucunun gerçek bağlam ve çıktı sınırlarını gelişmiş ayarlardan girebilirsin.
3. Yeni bir sohbet açıp modeli seç. Ajanın araç çalıştırabilmesi için endpoint’in akışlı Chat Completions, araç çağrısı ve araç sonucuyla devam eden istekleri desteklemesi gerekir.

Özel ağdaki her model API kökünü `SELF_HOSTED_MODEL_BASE_URLS` dizisine ekle. Bu izin yalnız model istemcisinin ilgili Chat Completions isteğini kapsar. Genel HTTPS endpoint’leri normal ağ çıkışını kullanır. Adresin sonundaki `/` isteğe bağlıdır. URL’ye anahtar, sorgu veya `/chat/completions` koyma. Yönlendiren bir adres kullanıyorsan nihai kökü gir.

| Modelin çalıştığı yer | Workshop’tan erişim |
| --- | --- |
| Aynı Docker ağı | Model container’ını bu ağa bağla. Örneğin mevcut container için `docker network connect --alias inference dockerflare MODEL_CONTAINER`. |
| Docker’ın kurulu olduğu Linux makinesi | Workshop’ı başlatırken `--add-host host.docker.internal:host-gateway` ver. Model Docker ağından dinlenebilir olmalı. Örnek kök `http://host.docker.internal:8000/v1`. |
| Başka bir makine | O makinenin Workshop’tan çözülen DNS adını ve açık API portunu kullan. Özel hedefi izin listesine ekle. HTTPS için sunucu sertifikasının güvenilir olması gerekir. |

## Bağlayıcılar

`GATEKEEPERS` virgülle ayrılmış etkin bağlayıcı listesidir. Varsayılan `context,scheduler` ile Context Library ve Scheduled Tasks yerel depolamayı kullanır. GitHub örneğinde listeyi `context,scheduler,github` yap ve korumalı env dosyasına `GATEKEEPER_GITHUB_CONFIG={"CLIENT_ID":"…","CLIENT_SECRET":"…"}` ekle. Bağlayıcı kendi ayarlarını alır. OAuth uygulamasında dönüş adresi `PUBLIC_BASE_URL/gatekeeper/github/oauth` olur. Oturum açma için de kullanmak istersen `AUTH_GATEKEEPERS=github` ver. [GitHub kurulum ayrıntıları](../packages/gatekeeper-github/README.md)

İmajla paketlenen diğer isteğe bağlı bağlayıcılar `cloudflare`, `confluence`, `gitlab`, `google`, `homeassistant`, `linear`, `mcp`, `mcpportal`, `microsoft`, `notion`, `pagerduty`, `slack`, `spotify`, `supabase`, `x` ve `zoominfo`. İlgili paketin README dosyasında gereken erişim bilgileri bulunur. Her vendor kendi çalışır hesabını ve erişimini gerektirir. Cloudflare Email Routing ve Workers AI tabanlı Web Search bu dağıtımın dışındadır. Browser Rendering isteyen dışa aktarımlar ve Workers AI ile belge dönüşümü ek bulut binding’i gerektirir. Metin içerikleri `webFetch` ile `raw: true` kullanılarak okunabilir.

Genel Worker ağ çıkışı yalnızca internet adreslerine açıktır. Örneğin Home Assistant bağlayıcısı etkinleştirilse bile ev ağındaki özel bir IP’ye doğrudan erişemez. Model endpoint’i için verilen özel ağ izni o bağlayıcıya aktarılmaz.

## Güncelleme ve yedek

Önce eski imajın etiketini ve env dosyanı sakla. Yeni sürüm için iki build komutunu yeni bir etiketle çalıştır. RPC sözleşmesini paylaşan web ve Workshop’ı aynı kaynak sürümünden dağıt. Container’ları durdurup kaldırdıktan sonra ilk açılış komutlarını yeni etiketlerle ve aynı adlandırılmış volume ile tekrarla. Geri dönüş için önceki imajlar ve o sürümün yedeği birlikte kullanılır.

Aşağıdaki Linux komutları durdurulmuş Workshop’tan tarihli bir arşiv alır. Arşivde kullanıcı verileri ve kayıtlı model anahtarları bulunduğu için erişimini kısıtla.

```sh
umask 077
backup="workshop-$(date +%Y%m%d-%H%M%S).tar"
docker stop workshop
docker run --rm --network none --user 0 --entrypoint tar \
  --mount source=dockerflare-data,target=/data,readonly \
  dockerflare/workshop:local -C /data -cf - . > "$backup"
docker start workshop
```

Geri yükleme için yeni bir volume kullan. Aynı env dosyasını ve `PUBLIC_BASE_URL` değerini koru. Yeni Workshop’ı başlatırken `source=dockerflare-restored,target=/data` ver. Doğrulama bitene kadar özgün volume’u sakla.

```sh
docker volume create dockerflare-restored
docker run --rm -i --network none --user 0 --entrypoint tar \
  --mount source=dockerflare-restored,target=/data \
  dockerflare/workshop:local -C /data -xf - < "$backup"
```

## Uçtan uca test

İki imajı build ettikten sonra Linux’ta, deponun pnpm bağımlılıkları kurulmuş bir checkout’tan `node docker/test/smoke.mjs dockerflare/web:local dockerflare/workshop:local` çalıştır. Test kendi geçici ağını, volume’larını ve kontrollü bir model endpoint’ini oluşturur. WebSocket, akışlı araç çağrısı, Context, zamanlayıcı, yeniden başlatma ve yedekten geri dönüşü sınar.

Docker Engine 29.9.3 ile Linux/amd64 üzerinde iki imaj uçtan uca test edildi. Chromium’da ilk kayıt, kurulum sihirbazı ve özel modelin kaydedilip sayfa yenilendiğinde tekrar görünmesi de doğrulandı. Linux/arm64 için üretilen iki imaj QEMU emülasyonunda başlatıldı. ARM64 nginx üzerinden arayüz ve Workshop WebSocket bağlantısı açıldı, üç başlangıç şablonu yüklendi.
