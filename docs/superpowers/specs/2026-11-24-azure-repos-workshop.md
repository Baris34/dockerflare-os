# Azure DevOps Server repolarıyla Workshop geliştirmesi

## İlk teslim

Bir kullanıcı şirket bilgisayarında `pnpm run-local` ile Workshop’u açar. Kendi PAT’iyle kurumun Azure DevOps Server collection’ına bağlanır, bir proje, Git reposu ve branch seçer. Ajan, seçilen commit’teki gerçek bir solution ve proje dosyalarını açıp hangi projelerin .NET Framework 4.8 hedeflediğini kaynak yollarıyla gösterir. Bu teslim Windows build makinesinden bağımsız denenebilir.

## Yaklaşım seçimi

Önce örnek bir 4.8 projesinde runner geliştirmek MSBuild döngüsünü ölçer. Önce Azure Repos’u bağlamak kullanıcının asıl başlama noktasını, yani kendi kodunu Workshop’a getirmesini sınar. Barış ikinci yolu seçti. Mevcut agent, worktree ve onay kuyruğu kullanılacak. Windows ve Linux runner aynı protokolü paylaşacak.

## Bağlantı ve yetki

- İşletmeci izin verilen HTTPS collection kökünü tanımlar. Sanal dizin dahil korunur. REST sürümü kurulumda belirlenir. Pilot varsayımı Server 2022 için 7.0. Kurumsal CA desteklenir. Yerel test, yapay bir Azure servisi kullanır.
- Hesap bağlantısı kullanıcıya özeldir. PAT tek kullanımlık bağlantı akışında POST ile alınır. Kullanıcı kimliği collection kapsamında Azure’un doğruladığı sabit kimlikle eşlenir. Yeniden bağlantı aynı sağlayıcı kimliğini gerektirir. Kabul edilmemiş reconnect eski bağlantıyı etkilemez. PAT modellerden, çalıştırılan koddan, URL ve loglardan uzak tutulur.
- Workshop’un kullanıcıya özel seçim ekranı proje/repo/branch sayfalarını yükler; adlar gösterim, GUID’ler kaynak kimliği içindir. Boş repo, erişim kaybı, sayfalama, boşluk içeren proje ve repo adları, eğik çizgi içeren branch adları ve değişmiş branch uçları ele alınır. Seçim sırasında ref yeniden okunur; uç değişmişse yeni seçim gösterilir. Özel ağa çıkan bağ sadece yapılandırılmış collection ve gereken Azure REST/Git yollarını kullanır. Yönlendirme üzerinden PAT aktarılmaz.
- Ajan sözleşmesi [types.d.ts](../../../packages/gatekeeper-azure-repos/src/types.d.ts). İnsanın seçtiği branch ve commit için tek yetenek verilir. `getCheckout()` tam commit’i Workshop’un `GitCache.advertiseCommit` mekanizmasına tanıtır. Ajan standart `createWorktree` aracıyla dosyaları açar. Kaynakta başvurduğu commit serbest bir RPC parametresi olamaz.
- Her gözlem, collection kimliği, proje ve repo GUID’leri, tam branch ref’i ve commit SHA’sı ile ilişkilidir. Workspace’i paylaşan her kişinin **kendi** Azure hesabıyla repo içeriği ve seçili ref/commit için erişimi doğrulanır. Salt proje adı veya repo listesi bu yetkiyi ispatlamaz. Branch silinmiş, geçmiş yeniden yazılmış, yetki kaldırılmış veya doğrulama belirsizse yeni paylaşım kapalı kalır. Olağan fast-forward durumunda seçili commit aynı branch’in geçmişindeyse çalışmaya devam edilir. Hesap keşfi ajana açılmaz.

## Git ve süreç sınırları

Seçilen commit ve o commit’teki dosyalar erişim sınırıdır. Barış bu sınırı 24 Kasım’da onayladı. Özgün Git commit’i ebeveyn kimliklerini içerebilir; bu bağlantı ebeveynlerin içeriğini sunmaz. Workspace’in önceden aldığı veriler kendi erişim modeliyle saklanır. Azure’a yapılan yeni okumalar ve yeni paylaşımlar canlı erişim denetiminden geçer.

Klasik Git smart HTTP, filtre kullanmadan tek commit derinliğinde çalışır. Sunucuya gönderilen tek `want` seçilen SHA’dır. Akış ek bir Git programı gerektirmeden workerd içinde çözülür. Git'in kendi `index-pack` komutuyla yapılan test seçilen dosyayı okur ve ebeveynin alınmadığını doğrular. Azure snapshot aktarımının üst sınırı 64 MiB’dir. Büyük repo, değişen veya artık sunucu tarafından sunulmayan ref ve kesilen aktarım sonuçları kullanıcıya hata olarak dönmelidir. PAT taşıyan ağ bağlantısı yalnız Azure gatekeeper’ına verilir. Docker ayrıca özel ağ çıkışını workerd servisleriyle sınırlar. Tek kullanıcılık yerel Wrangler ortamı ana makinenin ağ erişimini kullanır. Operatör kurumsal CA ekleyebilir. Pilot sırasında PAT ile REST ve Git fetch ayrı ayrı ölçülür.

İlk kabul reposu klasik `TargetFrameworkVersion=v4.8`, SDK biçimi `net48` ve değerini bir `.props` dosyasından alan birer proje içerir. Agent statik olarak çözemediği koşullu bir MSBuild değerini belirsiz gösterir; build ile doğrulama ikinci teslimdedir.

Worktree dosyalarının aslı Workshop’tadır. Seçili revision için Git nesneleri mevcut kernel arayüzüyle alınır; orijinal SHA ve dosya modları korunur. Azure DevOps Server kurulumlarının hepsinde kısmi klonun açık olduğu varsayılmaz. Klasik Git fetch ile de çalışan bir yol pilotun kabul koşuludur. Repo verisi açılmadan erişim kontrol edilir; onaysız uzak yazma yapılmaz.

Pilotun ikinci tesliminde Windows’taki runner, seçili çalışma ağacının bir kopyasında Nexus restore, MSBuild ve reponun test komutunu çalıştırır. Kullanıcı hem test çıktısını hem değişiklikleri görür. Pilot makinede runner ayrı, kısıtlı bir işletim sistemi hesabıyla çalışır. Runner’ın kayıt kimliği ve Azure PAT’i build ortamına verilmez. Kurumsal Nexus erişimi proje bazında salt okunur sağlanır. Üretimde Workshop RHEL’de, aynı Windows runner ayrılmış VM’de, Java/Python işleri ayrı Linux runner’da çalışır. Model bağlantısı var olan OpenAI uyumlu endpoint’i kullanır. Yerelde özel endpoint’e erişim ilk model turundan önce doğrulanır.

Son teslimde kullanıcı diff, hedef branch ve aynı Git ağacı için kaydedilmiş başarılı test sonucunu birlikte görür. Açık onayla `agents/<görev-kimliği>` açılır, onaylanan commit gönderilir ve seçilen hedefe PR oluşturulur. Değişen içerik onayı ve test sonucunu yeniler. İkinci deneme aynı işleme döner: push başarılıyken PR isteği kesilirse mevcut branch ve PR kontrol edilir. Çakışan branch üzerine yazılmaz. Birleştirme Azure’daki ekip sürecinde kalır.

Hedef branch onaydan önce ilerlerse yeni hedef ve yeni fark kullanıcıya gösterilir. Aday güncel hedefle yeniden hazırlanır; oluşan ağaç yeniden test edilir ve yeni onay istenir. Push ile PR oluşturma arasında hedefin ilerlemesi Azure'da atomik kontrol edilemez; çalıştırılan test açıkça hangi kaynak ve hedefe ait olduğunu taşır. Son birleştirmedeki güncellik Azure branch politikalarına aittir.
