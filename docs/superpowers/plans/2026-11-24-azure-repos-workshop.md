# Azure Repos, Windows ve Linux runner uygulama planı

**Hedef.** Bir geliştirici tarayıcıdan kendi Azure DevOps Server reposunu seçer, .NET Framework 4.8 hatasını Windows üzerinde yeniden üretip düzelttirir ve incelediği değişikliği onayla PR’a dönüştürür.

**Mimari.** Azure Repos gatekeeper’ı kimlik ve Git erişimini, Workshop sohbet ve çalışma ağacını, runner yalnızca görevin build/test ortamını yönetir. TypeScript, Cap’n Web, workerd, Git ve işletim sisteminin yerel derleme araçları kullanılır. [Tasarım](../specs/2026-11-24-azure-repos-workshop.md)

## 1. Azure hesabını bağlama ve repoyu seçme

- [x] Ajana tanınacak yetkiyi `packages/gatekeeper-azure-repos/src/types.d.ts` içinde tanımla. Barış yalnız seçilen sürüme erişimi onayladı.
- [x] `packages/gatekeeper-azure-repos` altında test Azure sunucusuyla collection kökü, proje ve repo sayfaları, tam branch ref'i, izin kaybı, süresi bitmiş PAT ve seçim sırasında değişen SHA vakalarını çalıştır. Veri ve erişim hataları kullanıcıya ayırt edilebilir biçimde dönsün.
- [x] Gatekeeper’ın hesap DO’sunda PAT bağlantısını, yeniden bağlantıyı ve disconnect’i mevcut handoff/ticket sözleşmesiyle uygula. İşletmecinin collection seçimini ve kurumsal CA doğrulamasını hem `pnpm run-local` hem Docker Workshop’a bağla. Gizli alanlara sahip istek gövdeleri ve kullanıcı başlıkları loglanmasın.
- [x] Repo/branch seçicisini mevcut resource configurator üzerinden sun. Başka kullanıcı aynı Workspace’i açtığında kendi hesabıyla doğrula. Sıfır sonuç, ağ kesintisi ve ikinci sayfa ayrı sınanmalı.
- [x] Seçilen SHA’yı checkout yeteneğiyle tanıt ve kernel’in `gitPull` sözleşmesini karşıla. Azure’un partial clone desteği kapalıyken de tam Git nesneleriyle orijinal SHA, binary dosya ve alt dizin okunmalı. Desteklenmeyen Git özelliklerini kullanıcıya görünür biçimde bildir.
- [x] `packages/integration-tests` içinde sentetik Azure + kontrollü model ile temiz hesaptan branch seçimine, `createWorktree` ve gerçek bir `.sln`/`.csproj` okumasına kadar test et.
- [ ] Şirket bilgisayarında gerçek Azure DevOps Server ve kurumsal modelle aynı denemeyi yap. SHA ve dosya yollarını Azure’daki sürümle karşılaştır.

**İlk kabul.** Kullanıcı PAT ile eriştiği iki repoyu ayırt eder, varsayılan dışı branch seçer. Sohbette gösterilen yol, target framework ve commit Azure’dakiyle eşleşir. Azure’a yazma gerekmez.

## 2. Yerel Windows pilotu ve .NET 4.8

- [ ] Ayrı Windows süreci için tek kullanımlık kayıt, göreve bağlı çalışma alanı ve dışarı doğru bağlantı ekle. Worktree replica ile test edilecek Git ağacını al.
- [ ] Kurumun NuGet kaynağı, CA, MSBuild ve test komutlarını repo profiline bağla. Kullanıcı PATH’ine veya genel bir Azure Pipelines havuzuna bağımlı olmasın. Başarılı temel commit, bilinçli hatalı değişiklik ve düzeltme ile sırayla sınanmalı.
- [ ] Test başlangıcı ve sonucu aynı worktree tree ID’si, runner profili ve komutla kayıtlı olsun. Ağ kesilirse veya işlem zaman aşımına uğrarsa işi başarısız/belirsiz göster; temizlenmeyen ortam sonraki kullanıcıya atanmasın. Çıktı boyutu sınırlı, süreç ağacı iptal edilebilir olsun.

**İkinci kabul.** Workshop’u ve runner’ı şirket bilgisayarında çalıştır. Değişmeyen testin önce kırılıp sonra geçtiğini sohbette gör. Azure repo refs listesinin bu sırada değişmediğini doğrula.

## 3. Onaylı branch ve PR

- [ ] Geçen testin ağaç kimliğini önerilen commit’le eşleştir. Kullanıcıya repo, hedef, diff, test ve `agents/<görev-kimliği>` kaynak branch’ini tek onayda göster. Daha sonra yapılan edit bu onayı kullanamaz.
- [ ] Gatekeeper’ın `applyAction` yolunda kaynak branch’i çakışma denetimiyle oluştur, commit’i gönder, PR’ı aç. Hedef branch’in ilerlemesini tekrar incelemeye sun. Kısmi başarıdan sonraki denemeler aynı kaynak için tek PR üretmeli.
- [ ] Reddetme, sahte test sonucu, eski onay, branch adı çakışması, push sonrasında ağ kesilmesi ve yetki kaybı testleri ekle. Pilot Azure reposunda doğrulama sırasında Azure’a yazma yalnız insan onayıyla gerçekleşsin.

## 4. RHEL dağıtımı

- [ ] Mevcut web ve Workshop Docker hedeflerini koru. Linux runner için ayrı build/run hedefi ve Windows Server için servis kurulumu ekle. Repo profili Java/JDK veya Python sürümüyle eşleşen runner’ı seçsin; Nexus Maven/PyPI erişimi aynı test yaklaşımıyla doğrulansın.
- [ ] İki eşzamanlı kullanıcıyla görevlerin/kimliklerin ayrılığını, runner yeniden başlatmayı ve iş iptalini test et. RHEL’deki Workshop ile ayrı Windows VM üzerinden 4.8 pilotunu tekrar çalıştır.

## İlk teslimde doğrulanan akış

Windows’ta temiz kopyadan `pnpm run-local` ve Edge ile PAT formu açıldı. Linux/amd64 Workshop imajında özel CA kullanan bir HTTPS test sunucusuna bağlanıldı ve proje listesi alındı. Kontrollü model ve Azure REST test sunucusuyla workerd üzerinden iki repo listelendi, varsayılan dışı dal seçildi ve dal ilerledikten sonra önceki SHA’daki proje dosyaları okundu. Başka bir kullanıcının Workspace’i açması kendi Azure izni eksikken reddedildi, izin verildiğinde kabul edildi. Workspace oluşturma kaydı şifreli seçim kimliğini taşır. Ön izin ekranında özel proje, repo, dal ve SHA bilgileri gizli kalır.

[Şirket bilgisayarında ilk deneme](../../../packages/gatekeeper-azure-repos/README.md) · [Uçtan uca kabul testi](../../../packages/integration-tests/__tests__/azure-repos-worktree.test.ts)

## Doğrulama ve inceleme

Her teslimde önce başarısız olması beklenen test, ardından uygulama ve aynı testin geçişi kaydedilir. Paket testleri, `pnpm configs:check`, `pnpm lint` ve değiştirilen akışın entegrasyon testi ilgili aşamada çalıştırılır. Kurumsal ağ ve gerçek PAT gerektiren kabul yereldeki kontrollü testlerden ayrı raporlanır. Kritik inceleme alanları collection yolu ve sayfalama, paylaşımda yetki kaybı, Git özellikleri kapalı eski kurulumlar, test edilen içerikle onayın eşleştirilmesi, ağ kesintisinde çift PR oluşmasıdır.
