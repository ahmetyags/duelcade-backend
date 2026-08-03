# Duelcade Backend

Duelcade mobil oyununun bağımsız, sunucu otoriteli backend projesidir.

Bu proje şu anda:

- Colyseus oda oluşturma, katılma ve reconnect yaşam döngüsünü,
- sıra tabanlı oyun kurallarını,
- hamle, süre, skor ve sonuç doğrulamasını,
- oda koltuğu ve oyuncu kimliği korumalarını,
- sunucu üretimli anonim oyuncu kimliğini ve döndürülen oturum tokenlarını,
- PostgreSQL üzerinde kalıcı maç geçmişini,
- idempotent XP ledger'ını, oyuncu seviyesini ve dört çekirdek mod ustalığını,
- günlük görev ilerlemesini ve yalnızca görsel kozmetik envanterini,
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
POST /v1/auth/refresh
POST /v1/auth/logout
GET|PATCH /v1/me
GET /v1/matches
GET /v1/progression
POST /v1/quests/:questKey/claim
PATCH /v1/me/cosmetics
```

Access tokenlar 15 dakika geçerlidir. Uzun ömürlü refresh tokenlar açık metin
olarak saklanmaz; SHA-256 özetleri PostgreSQL'de tutulur ve her yenilemede
değiştirilir. WebSocket oda koltuğunun kimliği access token içindeki sunucu
üretimli oyuncu UUID'sinden alınır.

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

1. Mobil uygulamada güvenli oturum ve maç geçmişi ekranı
2. PostgreSQL ilerleme, görev ve kozmetik modelleri
3. Redis oda kodu rezervasyonu ve matchmaking
4. Mobil uygulamanın tüketebileceği sürümlenmiş protocol paketi
5. Analytics, hata izleme ve production readiness endpoint'i
