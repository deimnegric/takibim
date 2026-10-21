# Giriş Çıkış Takip (PWA)

Firebase (ücretsiz Spark planı) + n8n + Telegram botu ile çalışır. Cloud Functions kullanılmaz (ücretli plan gerektirir); zamanlama n8n'de.

## Nasıl çalışır
1. Yönetici Excel vardiyasını yükler → her kişi için giriş ve çıkış kaydı oluşur.
2. n8n her dakika Firestore'a bakar. Giriş penceresi (varsayılan vardiyadan 14 dk önce – 15 dk sonra, örn. 08:31–09:00) açıldığında çalışana **5 dk arayla** Telegram mesajı gönderir.
3. Mesajdaki butona basıp "işlemi yaptım" diyen çalışan onaylanır, hatırlatma durur, panoda yeşil olur.
4. Pencere bitince hâlâ onay yoksa bildirimi açık yöneticilere "X kişisi kalbim girişini yapmadı, lütfen kontrol ediniz" gider. Panoda kırmızı kalır; yönetici çipe dokunup manuel onaylayabilir.

## Neden Telegram?
Telefon numarasıyla ücretsiz ve sınırsız mesaj atmanın tek gerçekçi yolu. Çalışan bota **bir kez** `/start` yazıp "Numaramı paylaş" der; bot numarayı vardiya listesindeki numarayla eşleştirir. SMS/WhatsApp ücretli veya kotalıdır. İsterseniz n8n'deki "Telegram Hatırlat" ve "Telegram Yönetici" düğümlerini başka bir kanalla değiştirebilirsiniz.

## Kurulum

### 1) Firebase
1. console.firebase.google.com → proje oluştur (Spark/ücretsiz kalsın).
2. **Build → Firestore Database** oluştur (production modu).
3. **Build → Authentication → Sign-in method → E-posta/Şifre** etkinleştir.
4. Proje ayarları → Web uygulaması ekle → config değerlerini `public/js/firebase-config.js` içine yapıştır.
5. Terminalde:
   ```
   npm i -g firebase-tools
   firebase login
   firebase use --add        # projeyi seç
   firebase deploy
   ```
   (Hosting + Firestore kuralları + indeks birlikte yüklenir. İndeksin oluşması birkaç dakika sürebilir.)

### 2) İlk yönetici (bir kereliğe mahsus)
- Authentication → Users → **Kullanıcı ekle**: e-posta `SICILNO@bimtakip.app`, şifre belirleyin.
- Firestore → `employees` koleksiyonu → belge kimliği = sicil no, alanlar: `sicil` (string), `ad` (string), `isAdmin` (boolean) **true**, `notify` (boolean) **true**.
- Siteye girip sağ üstten **Yönetici** → sicil no + şifre. Diğer yöneticileri artık panelden eklersiniz.

### 3) n8n
1. Google Cloud'da (aynı proje) bir **servis hesabı** oluşturun, rolü **Cloud Datastore User**; JSON anahtarını indirin.
2. n8n → Credentials → **Google Service Account API**: e-posta + private key, Scope: `https://www.googleapis.com/auth/datastore`.
3. Telegram'da **@BotFather** ile bot açın, token'ı alın; n8n'de **Telegram API** credential'ı oluşturun.
4. `n8n/01-hatirlatma-ve-uyari.json` ve `n8n/02-telegram-kayit.json` dosyalarını import edin.
5. İki akışta credential'ları seçin; ayrıca:
   - Akış 1 → **Sorgu Hazırla** düğümü: `PROJECT` ve `SITE_URL` değerlerini yazın.
   - Akış 2 → **Analiz** düğümü: `BOT_TOKEN` ve `PROJECT` değerlerini yazın.
6. İki akışı **aktif** edin.

### 4) Kullanım
- Panelden **Vardiya → Excel yükle**. Şablon için "Örnek şablon indir". Telefonlar Excel'den alınır.
- Çalışanlar botu açıp telefonunu paylaşır (Çalışanlar sekmesinde "Bot: bağlı" görünür).
- Ayarlar sekmesinden pencere süreleri, aralık ve sabah/akşam sınırı değiştirilir (yalnızca sonradan yüklenen vardiyalara uygulanır).

## Ücretsiz kota
Firestore Spark: günde 50 bin okuma / 20 bin yazma. n8n yalnızca penceresi açık ve onaylanmamış kayıtları sorgular, bu yüzden normal kullanım çok altında kalır. Aylık 100 kişilik vardiya yüklemesi yaklaşık 6 bin yazma eder. Telegram botları ücretsizdir.

## Bilmeniz gerekenler
- **Pano herkese açık okunur** (ad, saat, durum; telefon numarası dahil değil). Kilitlemek için `firestore.rules` içinde `attendance` okumasını `isAdmin()` yapın.
- Yönetici girişi sicil no + **şifre**dir (yalnızca sicil no güvenli olmazdı).
- Onay bağlantısı çalışana özeldir; bağlantıyı başkasıyla paylaşmayın.
- Onay, çalışanın beyanıdır; kalbim ile otomatik doğrulama yoktur. Şüpheli durumlarda yönetici kontrol eder.
- Excel formatınız farklıysa (haftalık tablo vb.) örnek dosyayı gönderin, okuyucuyu ona göre uyarlarız.
- n8n akışları elle yazıldı; import sonrası ilk testte Firestore/Telegram düğümlerini bir kez "Execute" ile deneyin.
