# SpoFlix — TÜBİTAK Proje Özeti

## Projenin konusu

SpoFlix, Türkiye'deki güncel müzik trendlerini tek bir ekranda sunan ve seçilen şarkıyı YouTube'un gömülü oynatıcısı üzerinden çalan web ve Windows uygulaması prototipidir.

## Problem ve amaç

Müzik keşfinde kullanıcılar farklı sayfalar arasında geçiş yapabilir; arama sonuçlarında ad, sanatçı ve süre bilgilerinin eksik görünmesi de seçim yapmayı zorlaştırır. SpoFlix'in amacı, trend listesini, temel bilgileri ve oynatma kontrollerini sade bir arayüzde bir araya getirmektir.

## Yöntem

1. Uygulama YouTube Data API üzerinden Türkiye bölgesinin müzik kategorisi için trend listesini ister.
2. Sunucu, sonuçları şarkı adı, kanal/sanatçı, kapak görseli, YouTube kimliği ve süre alanlarına dönüştürür.
3. Arayüz bu alanları sıralı bir listede gösterir.
4. Kullanıcı bir şarkı seçtiğinde YouTube IFrame oynatıcısı kullanılır. Uygulama ses akışını kendi sunucusunda barındırmaz.
5. Beğeniler, son çalınanlar ve yerel kitaplık bilgileri kullanıcının cihazında saklanır.

## Öne çıkan tasarım kararları

- Ana sayfa trendleri tek kaynaktan, YouTube'dan gelir; Apple Music entegrasyonu yoktur.
- Ayrı video/klip katalogları ve klip pencereleri kaldırılmıştır. YouTube oynatıcısı yalnızca şarkı çalma altyapısı olarak gizli çalışır.
- YouTube API anahtarı tarayıcıya gönderilmez ve Windows kurulum dosyasına konmaz.
- Masaüstü uygulamasında Node erişimi kapalıdır; sınırlı preload köprüsü yalnızca ses ayarını ana sürece iletir.
- Yerel API sunucusu yalnızca bilgisayardaki döngüsel ağ adresini dinler; ses aktarımında izin verilen kaynak alan adları denetlenir.

## Değerlendirme planı

Projeyi sunmadan önce aşağıdaki maddeler gerçek ortamda uygulanıp sonuçları kaydedilmelidir:

- Farklı ekran boyutlarında başlık, sanatçı, süre ve oynatma kontrollerinin görünürlüğü.
- Trend listesinden seçilen farklı şarkıların doğru sırayla başlatılması.
- Oynatılamayan veya gömülmesi engellenen bir içerikte kullanıcıya anlaşılır mesaj gösterilmesi.
- API anahtarı olmadan paketlenmiş masaüstü sürümünün yayınlanan API'ye bağlanması.
- Ağ bağlantısı yokken arama/trend ekranlarının çökmeden hata durumu göstermesi.
- Arama, beğeniler, son çalınanlar ve yerel kitaplığın beklenen şekilde çalışması.

Ölçüm yapılmadan sayısal başarı oranı, performans sonucu veya kullanıcı testi sonucu verilmemelidir.

## Sınırlılıklar

Trend sırası ve içerik erişimi YouTube hizmetlerine bağlıdır. Bazı videolarda gömülü oynatma kapalı olabilir. API kotası, ağ bağlantısı ve Vercel ayarları web sürümünün çalışmasını etkiler. Uygulama bir prototiptir; gerçek kullanıcı hesabı veya sunucuda eşitlenen kişisel kitaplık sağlamaz.