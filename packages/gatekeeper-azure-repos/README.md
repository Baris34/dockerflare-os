# Workshop’a Azure DevOps Server reposu bağlama

Workshop’a giriş yaptıktan sonra kişisel Azure PAT’ini bağlayıp erişebildiğin bir repo ve dalı seçebilirsin. Ajan, ekranda onayladığın Git commit’ini kendi çalışma ağacında açar. Bir kullanıcı Workspace’i paylaştığında diğer kişinin de aynı kaynağa kendi Azure hesabıyla erişebilmesi gerekir.

## Şirket bilgisayarında ilk deneme

1. Azure DevOps Server’da kullandığın **collection adresini** al. Örneğin `https://devops.sirket.local/tfs/DefaultCollection`. Repo ana sayfası, proje adı ve `/_git/` bu adrese dahil edilmez.
2. Repo kökündeki `.dev.vars` dosyasına aşağıdaki ayarları ekle. Model için şirket ağından erişilebilen OpenAI uyumlu adresi kullan. Kurum CA’sı gerekiyorsa PowerShell’de uygulamayı başlatmadan önce `$env:NODE_EXTRA_CA_CERTS = 'C:\sertifikalar\kurum-ca.pem'` ayarla.

   ```dotenv
   AZURE_DEVOPS_COLLECTION_URL=https://devops.sirket.local/tfs/DefaultCollection
   AZURE_DEVOPS_API_VERSION=7.0
   SELF_HOSTED_MODEL_BASE_URLS=["https://model.sirket.local/v1"]
   ```

3. Repo kökünde `pnpm.cmd run-local` çalıştır ve `http://localhost:8787` adresini aç. İlk çalıştırmada pnpm bağımlılıkları indirir ve ön yüzü derler. Ayarlar değiştiğinde süreci yeniden başlat. Modeli **AI providers → Add provider → OpenAI-compatible endpoint** üzerinden kaydet ve sohbet için seç. API kökü izin listesindeki adresle eşleşmeli.
4. Sohbette **Add connection** ekranını aç, **Azure Repos branch** seç ve Azure hesabını bağla. **Connect Azure Repos** penceresindeki **Personal access token** alanına kişisel PAT’ini gir. Pilot için **Code (Read)** ve **Project and Team (Read)** kapsamlarını kullan. PAT yalnız bu formda kullanılır. [Proje listeleme](https://learn.microsoft.com/en-us/rest/api/azure/devops/core/projects/list?view=azure-devops-rest-7.1) · [Git ref okuma](https://learn.microsoft.com/en-us/rest/api/azure/devops/git/refs/list?view=azure-devops-rest-7.0)
5. Projeni seç. **Search repositories** alanına repo adının bir bölümünü yaz. Arama seçili projede hesabının görebildiği tüm repoları kapsar. Repoyu ve dalı seçtikten sonra 40 karakterlik commit kimliğini kontrol edip bağlantıyı ekle. Seçim sırasında dal ilerlerse Workshop güncel kimliği tekrar onaylatır.

İlk sohbette şu isteği deneyebilirsin.

> Bağladığım repoda seçili commit’i aç. Solution dosyasını ve .NET Framework 4.8 hedefleyen projeleri yollarıyla göster. Hedef sürümünü bir .props dosyasından alan projelerde o dosyanın yolunu da ver. Kullandığın commit kimliğini yaz.

Yanıttaki SHA’yı Azure’da seçilen commit’le, proje yolunu da o sürümdeki dosyayla karşılaştır. Bu aşamada .NET Framework’ü derlemek için araç kurman gerekmez. Nexus restore, MSBuild ve test sonuçları Windows runner aşamasında eklenecek.

## RHEL üzerinde Docker

İki servis imajını build ettikten sonra Workshop servisinin env dosyasında Azure’u etkinleştir. [Docker kurulumu](../../docker/README.md)

```dotenv
GATEKEEPERS=context,scheduler,azurerepos
AZURE_DEVOPS_COLLECTION_URL=https://devops.sirket.local/tfs/DefaultCollection
AZURE_DEVOPS_API_VERSION=7.0
```

Özel sertifika otoritesi kullanılıyorsa Workshop container’ına PEM demetini salt okunur bağla. Örneğin `docker run` komutuna `--mount type=bind,src=/etc/pki/kurum-ca.pem,dst=/run/certs/azure.pem,readonly` ekle ve env dosyasında `AZURE_DEVOPS_CA_FILE=/run/certs/azure.pem` ayarla. Collection’ın DNS adı container içinden çözülebilmeli. Her kullanıcı tarayıcıdaki forma kendi PAT’ini girer. Sunucunun kalıcı Workshop volume’u kullanıcı bağlantılarını içerir.

## Pilot sınırları

- Varsayılan REST sürümü `7.0`. Farklı bir Azure DevOps Server sürümünde `AZURE_DEVOPS_API_VERSION` değerini o kurulumun desteklediği sürüme ayarla. Gerçek kurum sunucusundaki kabul, seçilen bir repo ve o kullanıcının PAT’iyle yapılır. [Microsoft’un sürüm eşlemesi](https://learn.microsoft.com/en-us/azure/devops/integrate/concepts/rest-api-versioning?view=azure-devops)
- Git aktarımı tek commit derinliğindedir ve sıkıştırılmış aktarım başına sınır 64 MiB’dir. Dal ileri giderse mevcut bağlantı seçilen SHA’da kalır. Yeniden yazılan veya silinen dal için yeni bir sürüm seçmek gerekir. Alt modül içeriği ve Git LFS sunucusundaki büyük dosyalar ayrıca alınmaz.
- Azure izinleri yeni okumalarda ve paylaşımda kontrol edilir. Önceden Workspace’e aktarılmış veya sohbette gösterilmiş içerik Workspace’in saklama kurallarına tabidir. Azure’a push ve PR açma ilerideki insan onayı aşamasındadır.
- Windows’taki `run-local` tek geliştiricilik pilot içindir. Wrangler ana makinenin ağ erişimini kullanır. Docker dağıtımında Azure’a özel ağ çıkışı yalnız bağlayıcıya açılır.
