# Duelcade Backend

Duelcade mobil oyununun bağımsız, sunucu otoriteli backend projesidir.

Bu proje şu anda:

- Colyseus oda oluşturma, katılma ve reconnect yaşam döngüsünü,
- sıra tabanlı oyun kurallarını,
- hamle, süre, skor ve sonuç doğrulamasını,
- oda koltuğu ve oyuncu kimliği korumalarını,
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
```

## Doğrulama

```bash
npm run typecheck
npm test
npm run verify
```

Test paketi oyun motorunu, iki istemcili gerçek Colyseus maçını, kimlik
çakışmasını ve kayıt olmadan oda koltuğu işgalini kapsar.

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

1. Sunucu üretimli misafir kimliği ve kısa ömürlü join ticket
2. PostgreSQL oyuncu, maç ve ilerleme modelleri
3. Redis oda kodu rezervasyonu, matchmaking ve rate limiting
4. Mobil uygulamanın tüketebileceği sürümlenmiş protocol paketi
5. Analytics, hata izleme ve production readiness endpoint'i
