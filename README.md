# Duelcade Backend

Duelcade mobil oyununun bağımsız, sunucu otoriteli backend projesidir.

Bu proje şu anda:

- Colyseus oda oluşturma, katılma ve reconnect yaşam döngüsünü,
- sıra tabanlı oyun kurallarını,
- hamle, süre, skor ve sonuç doğrulamasını,
- oda koltuğu ve oyuncu kimliği korumalarını,
- sunucu üretimli anonim oyuncu kimliğini ve döndürülen oturum tokenlarını,
- Google, Facebook, GitHub OAuth ve scrypt ile korunan e-posta hesaplarını,
- sunucu tarafından hesaplanan genel leaderboard'u,
- PostgreSQL üzerinde kalıcı maç geçmişini,
- idempotent XP ledger'ını, oyuncu seviyesini ve dört çekirdek mod ustalığını,
- günlük görev ilerlemesini ve yalnızca görsel kozmetik envanterini,
- açık rızaya bağlı, izin listeli ve 90 gün saklanan ürün analitiğini,
- kimliği doğrulanmış kapalı testçilerden gelen, 180 gün saklanan yapılandırılmış geri bildirimi,
- HTTP health endpoint'ini

yönetir.

## Gereksinimler

- Node.js 22.13 veya daha yeni bir 22.x sürümü
- npm 10 veya daha yeni

## Kurulum

```bash
cp .env.example .env
npm install
npm run dev
```

Sunucu varsayılan olarak `http://localhost:2567` adresinde çalışır.

```text
GET /health
POST /v1/auth/guest
POST /v1/auth/email/register
POST /v1/auth/email/login
GET /v1/auth/oauth/:provider/start
POST /v1/auth/oauth/exchange
POST /v1/auth/firebase/exchange
POST /v1/auth/refresh
POST /v1/auth/logout
GET|PATCH /v1/me
GET /v1/matches
GET /v1/leaderboard
GET /v1/progression
POST /v1/quests/:questKey/claim
PATCH /v1/me/cosmetics
POST /v1/analytics/events
POST /v1/feedback
```

Access tokenlar 15 dakika geçerlidir. Uzun ömürlü refresh tokenlar açık metin
olarak saklanmaz; SHA-256 özetleri PostgreSQL'de tutulur ve her yenilemede
değiştirilir. WebSocket oda koltuğunun kimliği access token içindeki sunucu
üretimli oyuncu UUID'sinden alınır.

OAuth istemci sırları yalnızca backend ortam değişkenlerinde tutulur. Google,
Facebook ve GitHub uygulamalarında callback adresini
`{PUBLIC_BASE_URL}/v1/auth/oauth/{provider}/callback` biçiminde kaydedin.

Firebase geçişinde `FIREBASE_PROJECT_ID` ve
`FIREBASE_AUTH_PROVIDERS=email,google,facebook,github` tanımlanır. İstemcinin
Firebase ID token'ı Google'ın herkese açık imzalama anahtarlarıyla doğrulanır ve
Firebase UID kalıcı bir Duelcade oyuncusuna eşlenir. Yalnızca ID token doğrulamak
için service-account private key gerekmez. Eski email/OAuth endpoint'leri geçiş
tamamlanana kadar geri dönüş olarak korunur.

Analitik endpoint'i geçerli access token ister, en fazla 25 olaylık batch kabul
eder ve olay adı/özelliklerini kapalı bir şemayla doğrular. İstemciden oyuncu
kimliği alınmaz; kayıt token sahibine bağlanır. Oda kodu, isim, mesaj, reklam
kimliği, serbest metin ve ham IP analitik kaydına yazılmaz. Kayıtlar yeni batch
alındığında 90 günlük saklama süresine göre temizlenir.

Geri bildirim endpoint'i geçerli access token ister ve gönderimleri istemci UUID'si
ile idempotent işler. Kategori, 1–5 puan, en fazla 1000 karakter açıklama, ekran
bağlamı, platform, uygulama/build sürümü ve dil saklanır. Oda kodu, reklam
kimliği, cihaz kimliği ve ham IP kaydedilmez. Serbest metin alanında kişisel
bilgi paylaşılmaması istemcide açıkça belirtilir; kayıtlar 180 gün tutulur.

Render Blueprint aynı Frankfurt bölgesinde dış erişime kapalı
`duelcade-postgres` veritabanını oluşturur ve servise internal `DATABASE_URL`
verir. `AUTH_TOKEN_SECRET` Blueprint tarafından rastgele üretilir.

## Doğrulama

```bash
npm run typecheck
npm test
npm run verify
```

Test paketi oyun motorunu, iki istemcili gerçek Colyseus maçını, token
döndürmeyi, sahte istemci kimliğinin reddini, kalıcı maç kaydını, kimlik
çakışmasını, tek-seferlik XP ödülünü, görev talebini, kozmetik sahipliğini ve
kayıt olmadan oda koltuğu işgalini kapsar.

## Mobil uygulama bağlantısı

`duelcade` Expo projesinin `.env` dosyasında:

```dotenv
EXPO_PUBLIC_GAME_SERVER_URL=http://localhost:2567
```

Fiziksel Android cihazda `localhost` yerine geliştirme bilgisayarının yerel ağ
IP adresi kullanılmalıdır. Production istemcisi yalnızca HTTPS/WSS endpoint'ine
bağlanacaktır.

## Dizinler

```text
server/   Colyseus odaları ve HTTP sunucusu
engine/   Sunucu otoriteli oyun kuralları
types/    Ağ protokolü ve ortak veri sözleşmeleri
tests/    Motor ve gerçek socket entegrasyon testleri
```

## Sonraki backend aşaması

1. Kapalı test grubunu ve test geri bildirim akışını hazırlamak
2. Veriye göre öğretici, zorluk ve maç süresini ayarlamak
3. Redis oda kodu rezervasyonu ve matchmaking
4. Mobil uygulamanın tüketebileceği sürümlenmiş protocol paketi
5. Leaderboard ve canlı etkinlik altyapısı
