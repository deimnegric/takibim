# Giriş Çıkış Takip (PWA)

Firebase (ücretsiz Spark) + Cloudflare Worker + Telegram botu ile çalışır. Cloud Functions kullanılmaz (ücretli plan gerektirir); zamanlama Worker'de.

## Nasıl çalışır
1. Yönetici Excel vardiyasını yükler → her kişi için giriş ve çıkış kaydı oluşur.
2. Worker her dakika Firestore'a bakar. Giriş penceresi (varsayılan vardiyadan 14 dk önce – 15 dk sonra, örn. 08:31–09:00) açıldığında çalışana **5 dk arayla** Telegram mesajı gönderir.
3. Mesajdaki butona basıp "işlemi yaptım" diyen çalışan onaylanır, hatırlatma durur, panoda yeşil olur.
4. Pencere bitince hâlâ onay yoksa bildirimi açık yöneticilere "X kişisi kalbim girişini yapmadı, lütfen kontrol ediniz" gider. Panoda kırmızı kalır; yönetici çipe dokunup manuel onaylayabilir.

## Neden Telegram?
Telefon numarasıyla ücretsiz ve sınırsız mesaj atmanın tek gerçekçi yolu. Çalışan bota **bir kez** `/start` yazıp "Numaramı paylaş" der; bot numarayı vardiya listesindeki numarayla eşleştirir. SMS/WhatsApp ücretli veya kotalıdır. İsterseniz Worker'deki "Telegram Hatırlat" ve "Telegram Yönetici" düğümlerini başka bir kanalla değiştirebilirsiniz.

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
   firebase deploy --only firestore
   ```
   (Hosting + Firestore kuralları + indeks birlikte yüklenir. İndeksin oluşması birkaç dakika sürebilir.)

### 2) İlk yönetici (bir kereliğe mahsus)
- Authentication → Users → **Kullanıcı ekle**: e-posta `SICILNO@bimtakip.app`, şifre belirleyin.
- Firestore → `employees` koleksiyonu → belge kimliği = sicil no, alanlar: `sicil` (string), `ad` (string), `isAdmin` (boolean) **true**, `notify` (boolean) **true**.
- Siteye girip sağ üstten **Yönetici** → sicil no + şifre. Diğer yöneticileri artık panelden eklersiniz.

### 3) Bildirim motoru
Worker yerine ücretsiz **Cloudflare Worker** kullanılır (Render ücretsiz planı Worker'i taşımaz, uyuyan sunucuda dakikalık zamanlayıcı da çalışmaz). Kurulum: [`worker/README.md`](worker/README.md)

### 4) Kullanım
- Panelden **Vardiya → Excel yükle**. Şablon için "Örnek şablon indir". Telefonlar Excel'den alınır.
- Çalışanlar botu açıp telefonunu paylaşır (Çalışanlar sekmesinde "Bot: bağlı" görünür).
- Ayarlar sekmesinden pencere süreleri, aralık ve sabah/akşam sınırı değiştirilir (yalnızca sonradan yüklenen vardiyalara uygulanır).

## Ücretsiz kota
Firestore Spark: günde 50 bin okuma / 20 bin yazma. Worker yalnızca penceresi açık ve onaylanmamış kayıtları sorgular, bu yüzden normal kullanım çok altında kalır. Aylık 100 kişilik vardiya yüklemesi yaklaşık 6 bin yazma eder. Telegram botları ücretsizdir.

## Bilmeniz gerekenler
- **Pano herkese açık okunur** (ad, saat, durum; telefon numarası dahil değil). Kilitlemek için `firestore.rules` içinde `attendance` okumasını `isAdmin()` yapın.
- Yönetici girişi sicil no + **şifre**dir (yalnızca sicil no güvenli olmazdı).
- Onay bağlantısı çalışana özeldir; bağlantıyı başkasıyla paylaşmayın.
- Onay, çalışanın beyanıdır; kalbim ile otomatik doğrulama yoktur. Şüpheli durumlarda yönetici kontrol eder.
- Excel formatınız farklıysa (haftalık tablo vb.) örnek dosyayı gönderin, okuyucuyu ona göre uyarlarız.
- Worker akışları elle yazıldı; import sonrası ilk testte Firestore/Telegram düğümlerini bir kez "Execute" ile deneyin.
