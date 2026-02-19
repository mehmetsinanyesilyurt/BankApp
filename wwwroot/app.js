/**
 * A. Bank - İnternet Şubesi Yönetim Scripti
 * Fonksiyon: Sekme yönetimi ve UI etkileşimleri
 */

document.addEventListener('DOMContentLoaded', () => {
    // Sayfa yüklendiğinde ilk etkileşimleri başlat
    console.log("A. Bank Sistemleri Aktif...");
});

/**
 * Sekmeler arası geçişi yöneten ana fonksiyon
 * @param {string} sectionId - Gösterilecek bölümün ID'si
 * @param {HTMLElement} element - Tıklanan buton
 */
function showSection(sectionId, element) {
    // 1. Tüm içerik bölümlerini bul ve gizle
    const sections = document.querySelectorAll('.content-section');
    sections.forEach(section => {
        section.classList.remove('active');
    });

    // 2. Tüm sidebar linklerini bul ve aktiflik sınıflarını temizle
    const links = document.querySelectorAll('.sidebar-link');
    links.forEach(link => {
        link.classList.remove('active');
    });

    // 3. Seçilen bölümü göster
    const targetSection = document.getElementById(sectionId);
    if (targetSection) {
        targetSection.classList.add('active');
    }

    // 4. Tıklanan butonu görsel olarak aktif yap
    if (element) {
        element.classList.add('active');
    }

    // 5. Üst başlıktaki sayfa adını dinamik olarak güncelle
    updatePageTitle(sectionId);
}

/**
 * Başlık güncelleme yardımcı fonksiyonu
 */
function updatePageTitle(id) {
    const titleElement = document.getElementById('page-title');
    const titles = {
        'dashboard': 'Genel Bakış',
        'transfer': 'Para Transfer İşlemleri',
        'cards': 'Kartlarım ve Limitlerim',
        'investment': 'Yatırım ve Piyasa Analizi'
    };

    if (titleElement && titles[id]) {
        titleElement.innerText = titles[id];
    }
}

/**
 * Örnek: Form gönderimi kontrolü (İleride genişletilebilir)
 */
function handleTransfer() {
    // Burada transfer butonuna tıklandığında yapılacak kontroller eklenebilir
    alert("İşleminiz güvenli bölgeye iletiliyor...");
}