# SpoFlix

SpoFlix, YouTube Türkiye müzik trendlerini gösteren ve şarkıları YouTube'un gömülü oynatıcısıyla çalan bir müzik uygulaması prototipidir. TÜBİTAK proje sunumu için geliştirilmektedir.

## Projenin amacı

Müzik keşfi, arama ve çalma işlevlerini tek bir arayüzde birleştirmek; kullanıcıların güncel şarkılara hızlıca ulaşmasını sağlamaktır. Ana sayfadaki liste Türkiye bölgesi için YouTube müzik kategorisi verilerinden alınır. Arayüzde şarkı adı, kanal/sanatçı, kapak, sıra ve süre gösterilir.

## Özellikler

- YouTube Türkiye müzik trendleri
- YouTube üzerinden gömülü şarkı oynatma
- Şarkı ve sanatçı arama
- Beğenilenler ve son çalınanlar
- Yerel şarkı dosyalarını ekleme
- Ses seviyesi, ses modları ve şarkı sözleri paneli
- Windows masaüstü kurulumu ve Vercel üzerinde web sürümü

Arama sonuçları YouTube, Audius ve Jamendo kaynaklarından birleştirilebilir. Deezer arama sonucu yalnızca kullanılabilir bir önizleme içeriyorsa oynatılabilir. Apple Music entegrasyonu bulunmaz.

## Kullanılan teknoloji

- Arayüz: HTML, CSS ve JavaScript
- Masaüstü uygulaması: Electron
- Trend ve arama verisi: YouTube Data API
- Yerel şarkı kitaplığı: IndexedDB; kullanıcı tercihleri: tarayıcı depolaması
- Yayın: Vercel sunucu fonksiyonları

YouTube API anahtarı yalnızca sunucuda tutulur. Yerel geliştirme için isteğe bağlı `local-secrets.json` kullanılır; bu dosya Git'e eklenmez ve kurulum dosyasına dahil edilmez. Kurulu masaüstü uygulaması, trend verisi için SpoFlix web API'sine bağlanır.

## Çalıştırma

```powershell
npm install
npm start
```

Windows kurulum dosyası oluşturmak için:

```powershell
npm run dist
```

Vercel'de YouTube isteklerinin çalışması için proje ayarlarında `YOUTUBE_DATA_API_KEY` değişkeni tanımlanmalıdır. Projenin ayrıca bir kullanıcı giriş sunucusu yoktur; görünen profil ve beğeniler cihazda saklanır.

## Bilinen sınırlar

- YouTube sahibi gömülü oynatmayı kapattıysa ilgili şarkı uygulama içinde çalmayabilir.
- Trendler ve arama internet bağlantısına ve dış servislerin erişilebilirliğine bağlıdır.
- Trend sırası YouTube'un sağladığı listeye dayanır; uygulamanın bağımsız müzik kalite değerlendirmesi değildir.
- Bu çalışma bir prototiptir; sonuçlar ölçülmeden başarı oranı veya kullanıcı testi sonucu iddia edilmemelidir.

Ayrıntılı proje özeti ve değerlendirme planı için [PROJE_DOSYASI.md](PROJE_DOSYASI.md) dosyasına bakın.