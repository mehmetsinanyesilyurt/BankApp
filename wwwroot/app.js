const state = {
    currentUser: null,
    toastTimeoutId: null
};

document.addEventListener('DOMContentLoaded', () => {
    bindUiEvents();
    restoreSession();
});

function bindUiEvents() {
    document.getElementById('support-button')?.addEventListener('click', () => {
        notify('Canlı destek ekibine bağlanılıyor...');
    });

    document.getElementById('account-detail-button')?.addEventListener('click', () => {
        if (!state.currentUser) {
            notify('Önce giriş yapmalısınız.');
            openAuthModal();
            return;
        }

        notify(`Hesap bakiyeniz: ${formatCurrency(state.currentUser.balance)}`);
    });

    document.getElementById('iban-share-button')?.addEventListener('click', async () => {
        if (!state.currentUser?.iban) {
            notify('Önce giriş yapmalısınız.');
            openAuthModal();
            return;
        }

        if (navigator.clipboard?.writeText) {
            await navigator.clipboard.writeText(state.currentUser.iban);
            notify('IBAN kopyalandı.');
            return;
        }

        notify(`IBAN: ${state.currentUser.iban}`);
    });

    document.getElementById('card-detail-button')?.addEventListener('click', () => {
        notify('Kart detayları açıldı: Kullanılabilir limit ₺37.550,00');
    });

    document.getElementById('transfer-button')?.addEventListener('click', handleTransfer);
    document.getElementById('logout-button')?.addEventListener('click', logout);

    document.getElementById('show-login')?.addEventListener('click', () => switchAuthTab('login'));
    document.getElementById('show-register')?.addEventListener('click', () => switchAuthTab('register'));
    document.getElementById('login-button')?.addEventListener('click', handleLogin);
    document.getElementById('register-button')?.addEventListener('click', handleRegister);
}

function restoreSession() {
    const username = localStorage.getItem('bankapp_username');
    if (!username) {
        openAuthModal();
        return;
    }

    fetch(`/api/account/${encodeURIComponent(username)}`)
        .then(response => response.ok ? response.json() : Promise.reject())
        .then(account => {
            setUser(account);
            closeAuthModal();
        })
        .catch(() => {
            openAuthModal();
        });
}

function switchAuthTab(tab) {
    const isLogin = tab === 'login';

    document.getElementById('login-form')?.classList.toggle('hidden', !isLogin);
    document.getElementById('register-form')?.classList.toggle('hidden', isLogin);

    document.getElementById('show-login')?.classList.toggle('bg-white', isLogin);
    document.getElementById('show-login')?.classList.toggle('text-slate-700', isLogin);
    document.getElementById('show-register')?.classList.toggle('bg-white', !isLogin);
    document.getElementById('show-register')?.classList.toggle('text-slate-700', !isLogin);
}

async function handleLogin() {
    const username = document.getElementById('login-username')?.value.trim();
    const password = document.getElementById('login-password')?.value;

    if (!username || !password) {
        notify('Kullanıcı adı ve şifre zorunlu.');
        return;
    }

    const result = await postJson('/api/auth/login', { username, password });
    if (!result.ok) {
        notify(result.message || 'Giriş başarısız.');
        return;
    }

    setUser(result.data);
    closeAuthModal();
    notify(`Hoş geldin ${result.data.username}.`);
}

async function handleRegister() {
    const username = document.getElementById('register-username')?.value.trim();
    const password = document.getElementById('register-password')?.value;

    if (!username || !password) {
        notify('Kullanıcı adı ve şifre zorunlu.');
        return;
    }

    const result = await postJson('/api/auth/register', { username, password });
    if (!result.ok) {
        notify(result.message || 'Kayıt başarısız.');
        return;
    }

    setUser(result.data);
    closeAuthModal();
    notify('Kayıt başarılı, hesabınız oluşturuldu.');
}

async function handleTransfer() {
    if (!state.currentUser) {
        notify('Transfer için giriş yapmalısınız.');
        openAuthModal();
        return;
    }

    const ibanInput = document.getElementById('to-iban');
    const amountInput = document.getElementById('transfer-amount');
    const noteInput = document.getElementById('transfer-note');

    const toIban = ibanInput?.value.trim() ?? '';
    const amount = Number(amountInput?.value ?? 0);
    const note = noteInput?.value.trim() ?? '';

    if (!toIban || toIban.length < 8) {
        notify('Lütfen geçerli bir IBAN girin.');
        return;
    }

    if (!Number.isFinite(amount) || amount <= 0) {
        notify('Transfer tutarı 0dan büyük olmalıdır.');
        return;
    }

    const result = await postJson('/api/account/transfer', {
        username: state.currentUser.username,
        toIban,
        amount,
        note
    });

    if (!result.ok) {
        notify(result.message || 'Transfer başarısız.');
        return;
    }

    state.currentUser = result.data.account;
    renderUser();

    amountInput.value = '';
    noteInput.value = '';
    ibanInput.value = '';

    notify(`${formatCurrency(amount)} transfer edildi.`);
}

function setUser(account) {
    state.currentUser = account;
    localStorage.setItem('bankapp_username', account.username);
    renderUser();
}

function renderUser() {
    if (!state.currentUser) {
        return;
    }

    const firstLetter = state.currentUser.username.charAt(0).toUpperCase();
    document.getElementById('header-username').textContent = state.currentUser.username;
    document.getElementById('header-avatar').textContent = firstLetter;
    document.getElementById('dashboard-balance').textContent = formatCurrency(state.currentUser.balance);
    document.getElementById('dashboard-iban').textContent = `IBAN: ${state.currentUser.iban}`;
    document.getElementById('from-account').value = `${state.currentUser.username} - ${formatCurrency(state.currentUser.balance)}`;
    document.getElementById('card-owner').textContent = state.currentUser.username.toUpperCase();
}

function logout() {
    localStorage.removeItem('bankapp_username');
    state.currentUser = null;
    openAuthModal();
    notify('Güvenli çıkış yapıldı.');
}

function openAuthModal() {
    document.getElementById('auth-modal')?.classList.remove('hidden');
}

function closeAuthModal() {
    document.getElementById('auth-modal')?.classList.add('hidden');
}

async function postJson(url, payload) {
    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        const data = await response.json();
        if (!response.ok) {
            return { ok: false, message: data?.message || 'İşlem başarısız.' };
        }

        return { ok: true, data };
    } catch {
        return { ok: false, message: 'Sunucuya ulaşılamıyor.' };
    }
}

function showSection(sectionId, element) {
    const sections = document.querySelectorAll('.content-section');
    sections.forEach(section => section.classList.remove('active'));

    const links = document.querySelectorAll('.sidebar-link');
    links.forEach(link => link.classList.remove('active'));

    const targetSection = document.getElementById(sectionId);
    if (targetSection) {
        targetSection.classList.add('active');
    }

    if (element) {
        element.classList.add('active');
    }

    updatePageTitle(sectionId);
}

function updatePageTitle(id) {
    const titleElement = document.getElementById('page-title');
    const titles = {
        dashboard: 'Genel Bakış',
        transfer: 'Para Transfer İşlemleri',
        cards: 'Kartlarım ve Limitlerim',
        investment: 'Yatırım ve Piyasa Analizi'
    };

    if (titleElement && titles[id]) {
        titleElement.innerText = titles[id];
    }
}

function formatCurrency(value) {
    return new Intl.NumberFormat('tr-TR', {
        style: 'currency',
        currency: 'TRY',
        minimumFractionDigits: 2
    }).format(value);
}

function notify(message) {
    const toast = document.getElementById('status-toast');
    if (!toast) {
        return;
    }

    toast.textContent = message;
    toast.classList.remove('hidden');

    if (state.toastTimeoutId) {
        clearTimeout(state.toastTimeoutId);
    }

    state.toastTimeoutId = setTimeout(() => {
        toast.classList.add('hidden');
    }, 2500);
}
