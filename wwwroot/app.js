const state = {
    currentUser: null,
    toastTimeoutId: null
};

// BAŞLANGIÇ
document.addEventListener('DOMContentLoaded', () => {
    bindUiEvents();
    restoreSession();
});

function bindUiEvents() {
    // Auth Butonları
    document.getElementById('login-button')?.addEventListener('click', handleLogin);
    document.getElementById('register-button')?.addEventListener('click', handleRegister);
    document.getElementById('show-login')?.addEventListener('click', () => switchAuthTab('login'));
    document.getElementById('show-register')?.addEventListener('click', () => switchAuthTab('register'));
    
    // İşlem Butonları
    document.getElementById('transfer-button')?.addEventListener('click', handleTransfer);
    document.getElementById('logout-button')?.addEventListener('click', logout);
}

// MENÜ GEÇİŞ FONKSİYONU
window.showSection = function(id, element) {
    document.querySelectorAll('.content-section').forEach(s => s.classList.remove('active'));
    document.querySelectorAll('.sidebar-link').forEach(l => l.classList.remove('active'));
    
    document.getElementById(id)?.classList.add('active');
    element?.classList.add('active');

    const titles = { dashboard: 'Genel Bakış', transfer: 'Para Transferi', cards: 'Kartlarım' };
    document.getElementById('page-title').textContent = titles[id] || 'A. Bank';
};

// GİZLİLİK MODU (GÖZ İKONU)
window.togglePrivacy = function() {
    const balanceEl = document.getElementById('dashboard-balance');
    const icon = document.getElementById('privacy-icon');
    const isHidden = balanceEl.textContent === '••••••';

    if (!isHidden) {
        balanceEl.dataset.oldValue = balanceEl.textContent;
        balanceEl.textContent = '••••••';
        icon.classList.replace('fa-eye', 'fa-eye-slash');
    } else {
        balanceEl.textContent = balanceEl.dataset.oldValue || formatCurrency(state.currentUser?.balance);
        icon.classList.replace('fa-eye-slash', 'fa-eye');
    }
};

// VERİ YÜKLEME VE GÜNCELLEME
function setUser(account) {
    state.currentUser = account;
    localStorage.setItem('bankapp_username', account.username);
    
    // UI Güncelle
    document.getElementById('header-username').textContent = account.username;
    document.getElementById('header-avatar').textContent = account.username.charAt(0).toUpperCase();
    document.getElementById('dashboard-balance').textContent = formatCurrency(account.balance);
    document.getElementById('dashboard-iban').textContent = `IBAN: ${account.iban}`;
    document.getElementById('card-owner').textContent = account.username.toUpperCase();
    
    renderTransactions(account.transactions || []);
}

function renderTransactions(transactions) {
    const list = document.getElementById('recent-transactions');
    if (!list) return;
    list.innerHTML = '';

    if (transactions.length === 0) {
        list.innerHTML = `<tr><td class="p-8 text-center text-slate-400 text-sm italic">Henüz bir işlem bulunmuyor.</td></tr>`;
        return;
    }

    transactions.slice().reverse().forEach(tx => {
        const row = document.createElement('tr');
        row.className = "border-b border-slate-50 hover:bg-slate-50 transition";
        row.innerHTML = `
            <td class="px-8 py-4 font-medium text-slate-700 text-sm">${tx.note}</td>
            <td class="px-8 py-4 text-right font-bold text-red-600 text-sm">-${formatCurrency(tx.amount)}</td>
        `;
        list.appendChild(row);
    });
}

// TRANSFER İŞLEMİ
async function handleTransfer() {
    const toIban = document.getElementById('to-iban').value.trim();
    const amount = parseFloat(document.getElementById('transfer-amount').value);
    const note = document.getElementById('transfer-note').value.trim() || "Para Transferi";

    if (!toIban || isNaN(amount) || amount <= 0) {
        notify("Lütfen geçerli IBAN ve tutar giriniz.");
        return;
    }

    const result = await postJson('/api/account/transfer', {
        username: state.currentUser.username,
        toIban,
        amount,
        note
    });

    if (result.ok) {
        setUser(result.data.account);
        notify("Transfer başarıyla tamamlandı.");
        document.getElementById('to-iban').value = '';
        document.getElementById('transfer-amount').value = '';
        document.getElementById('transfer-note').value = '';
        showSection('dashboard', document.querySelector('[onclick*="dashboard"]'));
    } else {
        notify(result.message);
    }
}

// AUTH VE API YARDIMCILARI
async function handleLogin() {
    const u = document.getElementById('login-username').value;
    const p = document.getElementById('login-password').value;
    const res = await postJson('/api/auth/login', { username: u, password: p });
    if (res.ok) { setUser(res.data); closeAuthModal(); notify("Giriş yapıldı."); }
    else notify(res.message);
}

async function handleRegister() {
    const u = document.getElementById('register-username').value;
    const p = document.getElementById('register-password').value;
    const res = await postJson('/api/auth/register', { username: u, password: p });
    if (res.ok) { setUser(res.data); closeAuthModal(); notify("Hesap açıldı."); }
    else notify(res.message);
}

async function restoreSession() {
    const saved = localStorage.getItem('bankapp_username');
    if (saved) {
        const res = await getJson(`/api/account/${encodeURIComponent(saved)}`);
        if (res.ok) { setUser(res.data); closeAuthModal(); return; }
    }
    openAuthModal();
}

// YARDIMCI ARAÇLAR
async function postJson(url, body) {
    try {
        const r = await fetch(url, { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body) });
        const d = await r.json();
        return r.ok ? {ok:true, data:d} : {ok:false, message:d.message};
    } catch { return {ok:false, message:"Sunucu hatası."}; }
}

async function getJson(url) {
    try { const r = await fetch(url); return r.ok ? {ok:true, data:await r.json()} : {ok:false}; }
    catch { return {ok:false}; }
}

function formatCurrency(v) { return new Intl.NumberFormat('tr-TR', { style: 'currency', currency: 'TRY' }).format(v || 0); }
function notify(msg) {
    const t = document.getElementById('status-toast');
    t.textContent = msg; t.classList.remove('opacity-0', 'translate-y-24'); t.classList.add('opacity-100', 'translate-y-0');
    if (state.toastTimeoutId) clearTimeout(state.toastTimeoutId);
    state.toastTimeoutId = setTimeout(() => { t.classList.add('opacity-0', 'translate-y-24'); }, 3000);
}
function openAuthModal() { document.getElementById('auth-modal').classList.remove('hidden'); }
function closeAuthModal() { document.getElementById('auth-modal').classList.add('hidden'); }
function switchAuthTab(tab) {
    const isL = tab === 'login';
    document.getElementById('login-form').classList.toggle('hidden', !isL);
    document.getElementById('register-form').classList.toggle('hidden', isL);
    document.getElementById('show-login').className = isL ? 'py-3 rounded-xl bg-white text-sm font-bold text-slate-800 shadow-sm' : 'py-3 rounded-xl text-sm font-bold text-slate-500';
    document.getElementById('show-register').className = !isL ? 'py-3 rounded-xl bg-white text-sm font-bold text-slate-800 shadow-sm' : 'py-3 rounded-xl text-sm font-bold text-slate-500';
}
function logout() { localStorage.clear(); location.reload(); }