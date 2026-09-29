# Dinamik Ada

Fedora (GNOME 48–50) için üst paneli ekranın ortasında küçük siyah bir adaya çeviren
GNOME Shell eklentisi.

- **Kapalıyken:** saat, tarih, şarj yüzdesi.
- **Tıklayınca:** yaylanarak açılır. İçinde büyük saat, kalan pil süresi, ses kaydırıcısı
  ve paneldeki bütün simgeler (hızlı ayarlar, takvim, diğer eklentiler) var.
- **Kapanması:** başlığa (saate) tıkla ya da imleci adadan çek. Menü açıkken kapanmaz.

## Kurulum

```bash
./install.sh
# oturumu kapat / aç
```

Kaldırmak ya da bir sorun olduğunda paneli geri getirmek için:

```bash
gnome-extensions disable dinamik-ada@himuraw
```

## Geliştirme

Wayland'de shell yeniden başlatılamadığı için değişiklikleri iç içe bir oturumda dene:

```bash
sudo dnf install mutter-devkit
dbus-run-session gnome-shell --devkit --wayland
```

Hatalar: `journalctl -f -o cat /usr/bin/gnome-shell`

## Nasıl çalışıyor

- Paneli (`Main.panel`) gizler, yerine panel kutusuna 40 px'lik şeffaf bir şerit koyar;
  pencereler bu şeridin altında kalır. Ada bu şeridin ortasında durur.
  `extension.js` içindeki `STRIP_HEIGHT` 0 yapılırsa ada pencerelerin üstünde yüzer.
- Panelin sol/orta/sağ kutularındaki simgeler adanın tepsisine taşınır; sonradan açılan
  eklentilerin simgeleri de otomatik gelir. Eklenti kapatılınca hepsi eski yerine döner.
