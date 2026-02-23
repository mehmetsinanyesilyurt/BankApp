const BASE_URL = "";

const state = {
    currentUser: null,
    authToken: null,
    balanceHidden: false,
    txFilter: "all",
    busy: new Set(),
    reminders: [],
    reminderTimerStarted: false,
    loadingCount: 0,
    spendingChart: null,
    loanSimulation: null
};

const investmentPrices = {
    Altin: 3450,
    USD: 36.9,
    EUR: 39.8,
    "Fon Sepeti": 12.4
};

const marketSnapshot = {
    usd: 36.9,
    eur: 39.8,
    gold: 3450
};

const loanTypePresets = {
    "Ihtiyac Kredisi": { rate: 3.19, defaultMonths: 24 },
    "Konut Kredisi": { rate: 2.45, defaultMonths: 120 },
    "TasIt Kredisi": { rate: 3.05, defaultMonths: 36 },
    "KOBI Kredisi": { rate: 3.75, defaultMonths: 18 }
};

document.addEventListener("DOMContentLoaded", async () => {
    state.authToken = localStorage.getItem("abank_token");
    bindEvents();
    initTheme();
    startReminderWatcher();
    startMarketPolling();
    updateInvestmentPrice();
    await refreshMarketRates();
    resetLoanSimulation();
    handleLoanTypeChange();
    await restoreSession();
});

function bindEvents() {
    document.getElementById("show-login")?.addEventListener("click", () => switchAuthMode("login"));
    document.getElementById("show-register")?.addEventListener("click", () => switchAuthMode("register"));

    document.getElementById("login-button")?.addEventListener("click", handleLogin);
    document.getElementById("register-button")?.addEventListener("click", handleRegister);

    document.getElementById("transfer-button")?.addEventListener("click", handleTransfer);
    document.getElementById("bill-pay-button")?.addEventListener("click", handleBillPayment);
    document.getElementById("investment-buy-button")?.addEventListener("click", handleInvestmentBuy);
    document.getElementById("card-limit-increase-button")?.addEventListener("click", handleCardLimitIncrease);
    document.getElementById("card-debt-payment-button")?.addEventListener("click", handleCardDebtPayment);
    document.getElementById("card-cash-advance-button")?.addEventListener("click", handleCardCashAdvance);
    document.getElementById("card-settings-save-button")?.addEventListener("click", handleCardSettingsSave);
    document.getElementById("card-settings-reset-button")?.addEventListener("click", handleCardSettingsReset);
    document.getElementById("virtual-card-create-button")?.addEventListener("click", handleVirtualCardCreate);
    document.getElementById("virtual-card-spend-button")?.addEventListener("click", handleVirtualCardSpend);
    document.getElementById("application-submit-button")?.addEventListener("click", handleLoanApplication);

    document.getElementById("simulate-loan-button")?.addEventListener("click", handleLoanSimulation);
    document.getElementById("sim-apply-button")?.addEventListener("click", handleSimulatorApply);
    document.getElementById("sim-loan-type")?.addEventListener("change", handleLoanTypeChange);
    document.getElementById("settings-save-button")?.addEventListener("click", handleSettingsSave);
    document.getElementById("settings-change-password-button")?.addEventListener("click", handlePasswordChange);
    document.getElementById("settings-reset-local-button")?.addEventListener("click", handleSettingsResetLocal);
    document.getElementById("settings-copy-iban-button")?.addEventListener("click", handleCopyIban);
    document.getElementById("settings-clear-reminders-button")?.addEventListener("click", handleClearReminders);

    document.getElementById("theme-toggle-button")?.addEventListener("click", toggleTheme);
    document.getElementById("add-reminder-button")?.addEventListener("click", handleAddReminder);
    document.getElementById("reminders-list")?.addEventListener("click", handleReminderListClick);

    document.getElementById("logout-button")?.addEventListener("click", logout);
    document.getElementById("investment-asset")?.addEventListener("change", updateInvestmentPrice);

    document.querySelectorAll("[data-tx-filter]").forEach((button) => {
        button.addEventListener("click", () => {
            state.txFilter = button.dataset.txFilter || "all";
            updateFilterButtons();
            renderTransactions(state.currentUser?.transactions || []);
        });
    });

    document.querySelectorAll("#login-form input, #register-form input").forEach((input) => {
        input.addEventListener("keydown", (event) => {
            if (event.key !== "Enter") {
                return;
            }

            event.preventDefault();
            if (input.closest("#login-form")) {
                handleLogin();
            } else {
                handleRegister();
            }
        });
    });

    window.showSection = showSection;
    window.togglePrivacy = togglePrivacy;
}

async function handleRegister() {
    const tcNo = normalizeDigits(getInputValue("register-tcno"));
    const phone = normalizeDigits(getInputValue("register-phone"));
    const password = getInputValue("register-password");

    if (!tcNo || !phone || !password) {
        setAuthMessage("Tüm alanlar zorunludur.", true);
        return;
    }

    const result = await withBusy("register-button", () =>
        postJson("/api/auth/register", { tcNo, phone, password }, "Kayıt oluşturuluyor...")
    );

    if (!result.ok) {
        setAuthMessage(result.message, true);
        notify(result.message, "error");
        return;
    }

    const account = result.data?.account || result.data;
    const token = result.data?.token || null;

    if (!account?.tcNo || !token) {
        setAuthMessage("Sunucudan gecersiz yanit alindi.", true);
        notify("Kayıt sonrası oturum başlatılamadı.", "error");
        return;
    }

    setSessionToken(token);
    setUser(account);
    localStorage.setItem("abank_tcno", account.tcNo);
    markUserLogin(account.tcNo);
    closeAuthModal();
    clearAuthFields();
    setAuthMessage("", false);
    notify("Kayıt başarılı. Hoş geldiniz.", "success");
}

async function handleLogin() {
    const tcNo = normalizeDigits(getInputValue("login-tcno"));
    const password = getInputValue("login-password");

    if (!tcNo || !password) {
        setAuthMessage("Tüm alanlar zorunludur.", true);
        return;
    }

    const result = await withBusy("login-button", () =>
        postJson("/api/auth/login", { tcNo, password }, "Giriş doğrulanıyor...")
    );

    if (!result.ok) {
        setAuthMessage(result.message, true);
        notify(result.message, "error");
        return;
    }

    const account = result.data?.account || result.data;
    const token = result.data?.token || null;

    if (!account?.tcNo || !token) {
        setAuthMessage("Sunucudan gecersiz yanit alindi.", true);
        notify("Giriş sonrası oturum başlatılamadı.", "error");
        return;
    }

    setSessionToken(token);
    setUser(account);
    localStorage.setItem("abank_tcno", account.tcNo);
    markUserLogin(account.tcNo);
    closeAuthModal();
    clearAuthFields();
    setAuthMessage("", false);
    notify("Giriş başarılı.", "success");
}

async function handleTransfer() {
    if (!state.currentUser) {
        notify("İşlem için önce giriş yapın.", "error");
        return;
    }

    const toIban = getInputValue("to-iban");
    const amount = toNumber(getInputValue("transfer-amount"));
    const note = getInputValue("transfer-note") || "Para transferi";

    if (!toIban || amount <= 0) {
        notify("Geçerli IBAN ve tutar giriniz.", "error");
        return;
    }

    const result = await withBusy("transfer-button", () =>
        postJson(
            "/api/account/transfer",
            {
                toIban,
                amount,
                note
            },
            "Transfer gerçekleştiriliyor..."
        )
    );

    if (!result.ok) {
        notify(result.message, "error");
        return;
    }

    setUser(result.data.account);
    resetInputs(["to-iban", "transfer-amount", "transfer-note"]);
    notify("Transfer başarılı.", "success");
}

async function handleBillPayment() {
    if (!state.currentUser) {
        notify("İşlem için önce giriş yapın.", "error");
        return;
    }

    const institution = getInputValue("bill-institution");
    const subscriberNo = getInputValue("bill-subscriber-no");
    const amount = toNumber(getInputValue("bill-amount"));
    const note = getInputValue("bill-note");

    if (!institution || !subscriberNo || amount <= 0) {
        notify("Fatura bilgilerini eksiksiz giriniz.", "error");
        return;
    }

    const result = await withBusy("bill-pay-button", () =>
        postJson(
            "/api/account/bill-payment",
            {
                institution,
                subscriberNo,
                amount,
                note
            },
            "Fatura ödemesi yapılıyor..."
        )
    );

    if (!result.ok) {
        notify(result.message, "error");
        return;
    }

    setUser(result.data.account);
    resetInputs(["bill-subscriber-no", "bill-amount", "bill-note"]);
    notify("Fatura ödemesi tamamlandı.", "success");
}

async function handleInvestmentBuy() {
    if (!state.currentUser) {
        notify("İşlem için önce giriş yapın.", "error");
        return;
    }

    const asset = getInputValue("investment-asset");
    const amount = toNumber(getInputValue("investment-amount"));
    const unitPrice = Number(investmentPrices[asset] || 0);

    if (!asset || amount <= 0 || unitPrice <= 0) {
        notify("Yatırım bilgilerini kontrol edin.", "error");
        return;
    }

    const result = await withBusy("investment-buy-button", () =>
        postJson(
            "/api/investments/buy",
            {
                asset,
                unitPrice,
                amount
            },
            "Yatırım emri işleniyor..."
        )
    );

    if (!result.ok) {
        notify(result.message, "error");
        return;
    }

    setUser(result.data.account);
    resetInputs(["investment-amount"]);
    notify("Yatırım işlemi başarılı.", "success");
}

async function handleCardLimitIncrease() {
    if (!state.currentUser) {
        notify("İşlem için önce giriş yapın.", "error");
        return;
    }

    const amount = toNumber(getInputValue("card-limit-increase-amount"));
    if (amount <= 0) {
        notify("Artış tutarı geçersiz.", "error");
        return;
    }

    const result = await withBusy("card-limit-increase-button", () =>
        postJson(
            "/api/cards/limit-increase",
            {
                amount
            },
            "Kart limiti güncelleniyor..."
        )
    );

    if (!result.ok) {
        notify(result.message, "error");
        return;
    }

    setUser(result.data.account);
    resetInputs(["card-limit-increase-amount"]);
    notify("Kart limiti artırıldı.", "success");
}

async function handleCardDebtPayment() {
    if (!state.currentUser) {
        notify("İşlem için önce giriş yapın.", "error");
        return;
    }

    const amount = toNumber(getInputValue("card-debt-payment-amount"));
    if (amount <= 0) {
        notify("Ödeme tutarı geçersiz.", "error");
        return;
    }

    const result = await withBusy("card-debt-payment-button", () =>
        postJson(
            "/api/cards/debt-payment",
            {
                amount
            },
            "Kart borcu ödeniyor..."
        )
    );

    if (!result.ok) {
        notify(result.message, "error");
        return;
    }

    setUser(result.data.account);
    resetInputs(["card-debt-payment-amount"]);
    notify("Kart borcu ödendi.", "success");
}

async function handleCardCashAdvance() {
    if (!state.currentUser) {
        notify("İşlem için önce giriş yapın.", "error");
        return;
    }

    const amount = toNumber(getInputValue("card-cash-advance-amount"));
    if (amount <= 0) {
        notify("Nakit avans tutarı geçersiz.", "error");
        return;
    }

    const result = await withBusy("card-cash-advance-button", () =>
        postJson(
            "/api/cards/cash-advance",
            {
                amount
            },
            "Nakit avans hazırlanıyor..."
        )
    );

    if (!result.ok) {
        notify(result.message, "error");
        return;
    }

    setUser(result.data.account);
    resetInputs(["card-cash-advance-amount"]);
    notify("Nakit avans hesabınıza aktarıldı.", "success");
}

async function handleCardSettingsSave() {
    if (!state.currentUser) {
        notify("İşlem için önce giriş yapın.", "error");
        return;
    }

    const alias = getInputValue("card-settings-alias");
    const dailySpendingLimit = toNumber(getInputValue("card-settings-daily-limit"));
    const statementDayRaw = Number.parseInt(getInputValue("card-settings-statement-day"), 10);

    if (!alias) {
        notify("Kart takma adı boş bırakılamaz.", "error");
        return;
    }

    if (alias.length > 40) {
        notify("Kart takma adı en fazla 40 karakter olabilir.", "error");
        return;
    }

    if (dailySpendingLimit <= 0) {
        notify("Günlük kart limiti sıfırdan büyük olmalıdır.", "error");
        return;
    }

    if (!Number.isFinite(statementDayRaw) || statementDayRaw < 1 || statementDayRaw > 28) {
        notify("Ekstre günü 1 ile 28 arasında olmalıdır.", "error");
        return;
    }

    const payload = {
        alias,
        onlinePaymentsEnabled: getCheckboxValue("card-settings-online"),
        contactlessEnabled: getCheckboxValue("card-settings-contactless"),
        internationalUsageEnabled: getCheckboxValue("card-settings-international"),
        cashAdvanceEnabled: getCheckboxValue("card-settings-cash-advance"),
        isTemporarilyBlocked: getCheckboxValue("card-settings-frozen"),
        autoDebtPaymentEnabled: getCheckboxValue("card-settings-auto-debt"),
        notifyOnTransactions: getCheckboxValue("card-settings-notify"),
        dailySpendingLimit,
        statementDay: statementDayRaw
    };

    const result = await withBusy("card-settings-save-button", () =>
        postJson("/api/cards/settings/update", payload, "Kart ayarları kaydediliyor...")
    );

    if (!result.ok) {
        notify(result.message, "error");
        return;
    }

    setUser(result.data.account);
    notify("Kart ayarları güncellendi.", "success");
}

function handleCardSettingsReset() {
    if (!state.currentUser?.card) {
        notify("Kart bilgisi bulunamadı.", "error");
        return;
    }

    applyCardSettingsToForm(state.currentUser.card);
    notify("Kart ayar formu mevcut değerlere döndürüldü.", "info");
}

async function handleVirtualCardCreate() {
    if (!state.currentUser) {
        notify("İşlem için önce giriş yapın.", "error");
        return;
    }

    const limit = toNumber(getInputValue("virtual-card-limit-input"));
    if (limit <= 0) {
        notify("Sanal kart limiti geçersiz.", "error");
        return;
    }

    const result = await withBusy("virtual-card-create-button", () =>
        postJson(
            "/api/cards/virtual/create",
            { limit },
            "Sanal kart hazırlanıyor..."
        )
    );

    if (!result.ok) {
        notify(result.message, "error");
        return;
    }

    setUser(result.data.account);
    resetInputs(["virtual-card-limit-input"]);
    notify("Sanal kart güncellendi.", "success");
}

async function handleVirtualCardSpend() {
    if (!state.currentUser) {
        notify("İşlem için önce giriş yapın.", "error");
        return;
    }

    const amount = toNumber(getInputValue("virtual-card-spend-amount"));
    if (amount <= 0) {
        notify("Sanal kart harcama tutarı geçersiz.", "error");
        return;
    }

    const result = await withBusy("virtual-card-spend-button", () =>
        postJson(
            "/api/cards/virtual/spend",
            { amount },
            "Sanal kart işlemi gerçekleştiriliyor..."
        )
    );

    if (!result.ok) {
        notify(result.message, "error");
        return;
    }

    setUser(result.data.account);
    resetInputs(["virtual-card-spend-amount"]);
    notify("Sanal kart işlemi başarılı.", "success");
}

async function handleLoanApplication() {
    if (!state.currentUser) {
        notify("İşlem için önce giriş yapın.", "error");
        return;
    }

    const loanType = getInputValue("application-loan-type");
    const amount = toNumber(getInputValue("application-amount"));
    const months = Number.parseInt(getInputValue("application-months"), 10);

    if (!loanType || amount <= 0 || !Number.isFinite(months) || months <= 0) {
        notify("Başvuru bilgileri eksik veya geçersiz.", "error");
        return;
    }

    const result = await withBusy("application-submit-button", () =>
        postJson(
            "/api/applications/loan",
            {
                loanType,
                amount,
                months
            },
            "Başvuru gönderiliyor..."
        )
    );

    if (!result.ok) {
        notify(result.message, "error");
        return;
    }

    setUser(result.data.account);
    resetInputs(["application-amount", "application-months"]);
    notify("Başvurunuz alınmıştır.", "success");
}

function handleLoanTypeChange() {
    const loanType = getInputValue("sim-loan-type") || "Ihtiyac Kredisi";
    const preset = loanTypePresets[loanType];
    if (!preset) {
        return;
    }

    setInputValue("sim-loan-rate", String(preset.rate));

    const currentMonths = Number.parseInt(getInputValue("sim-loan-months"), 10);
    if (!Number.isFinite(currentMonths) || currentMonths <= 0) {
        setInputValue("sim-loan-months", String(preset.defaultMonths));
    }

    setText("sim-selected-type", prettifyLoanType(loanType));
}

function handleLoanSimulation() {
    const loanType = getInputValue("sim-loan-type") || "Ihtiyac Kredisi";
    const amount = toNumber(getInputValue("sim-loan-amount"));
    const months = Number.parseInt(getInputValue("sim-loan-months"), 10);
    const rate = toNumber(getInputValue("sim-loan-rate"));

    if (amount <= 0 || !Number.isFinite(months) || months <= 0 || rate < 0) {
        notify("Simülasyon için geçerli tutar, vade ve faiz oranı giriniz.", "error");
        return;
    }

    const simulation = calculateLoanPlan(amount, months, rate);
    state.loanSimulation = {
        loanType,
        amount,
        months,
        rate,
        ...simulation
    };

    setText("sim-selected-type", prettifyLoanType(loanType));
    setText("sim-monthly-payment", formatCurrency(simulation.monthlyPayment));
    setText("sim-total-payment", formatCurrency(simulation.totalPayment));
    setText("sim-total-interest", formatCurrency(simulation.totalInterest));
    setText("sim-first-installment-date", formatInstallmentDate(1));
    setText("sim-plan-note", `${months} ay için ödeme planı hazırlandı.`);
    renderLoanPlan(simulation.schedule);
    notify("Kredi simülasyonu hesaplandı.", "success");
}

function handleSimulatorApply() {
    if (!state.loanSimulation) {
        notify("Önce kredi simülasyonunu hesaplayın.", "error");
        return;
    }

    const mappedLoanType = mapLoanTypeForApplication(state.loanSimulation.loanType);
    if (mappedLoanType !== state.loanSimulation.loanType) {
        notify("Bu kredi tipi başvuru modülünde desteklenmediği için İhtiyaç Kredisi seçildi.", "info");
    }

    setInputValue("application-loan-type", mappedLoanType);
    setInputValue("application-amount", String(state.loanSimulation.amount));
    setInputValue("application-months", String(state.loanSimulation.months));

    const applicationsButton = document.querySelector(".sidebar-item[onclick*=\"showSection('applications'\"]");
    if (applicationsButton) {
        showSection("applications", applicationsButton);
    } else {
        showSection("applications");
    }

    notify("Simülasyon bilgileri başvuru formuna aktarıldı.", "success");
}

async function handleSettingsSave() {
    if (!state.currentUser) {
        notify("İşlem için önce giriş yapın.", "error");
        return;
    }

    const username = getInputValue("settings-username");
    const phone = normalizeDigits(getInputValue("settings-phone"));
    const email = getInputValue("settings-email");
    const address = getInputValue("settings-address");
    const language = getInputValue("settings-language") || "tr-TR";
    const theme = getInputValue("settings-theme") || getActiveTheme();
    const dailyTransferLimit = toNumber(getInputValue("settings-daily-transfer-limit"));
    const notificationsEnabled = getCheckboxValue("settings-notifications");
    const emailNotify = getCheckboxValue("settings-email-notify");
    const smsNotify = getCheckboxValue("settings-sms-notify");
    const reminderEnabled = getCheckboxValue("settings-reminders");
    const autoBillPay = getCheckboxValue("settings-auto-bill-pay");
    const fastLogin = getCheckboxValue("settings-fast-login");

    if (!username || !phone) {
        notify("Ad soyad ve telefon zorunludur.", "error");
        return;
    }

    if (phone.length < 10) {
        notify("Telefon numarası geçersiz görünüyor.", "error");
        return;
    }

    const result = await withBusy("settings-save-button", () =>
        postJson(
            "/api/settings/update",
            {
                username,
                phone,
                email,
                address,
                notificationsEnabled,
                reminderEnabled,
                language,
                dailyTransferLimit
            },
            "Ayarlar kaydediliyor..."
        )
    );

    if (!result.ok) {
        notify(result.message, "error");
        return;
    }

    const localPrefs = {
        ...getUserLocalPreferences(state.currentUser.tcNo),
        theme: theme === "dark" ? "dark" : "light",
        dailyTransferLimit: dailyTransferLimit > 0 ? roundMoney(dailyTransferLimit) : 0,
        emailNotify,
        smsNotify,
        autoBillPay,
        fastLogin,
        lastSync: new Date().toISOString()
    };
    saveUserLocalPreferences(state.currentUser.tcNo, localPrefs);
    applyTheme(localPrefs.theme);

    setUser(result.data.account);
    setText("settings-last-sync", formatDate(localPrefs.lastSync));
    notify("Ayarlar güncellendi.", "success");
}

function handleSettingsResetLocal() {
    if (!state.currentUser) {
        notify("İşlem için önce giriş yapın.", "error");
        return;
    }

    localStorage.removeItem(localSettingsStorageKey(state.currentUser.tcNo));
    renderSettings(state.currentUser);
    notify("Yerel tercihler sıfırlandı.", "info");
}

async function handleCopyIban() {
    if (!state.currentUser?.iban) {
        notify("IBAN bilgisi bulunamadı.", "error");
        return;
    }

    const iban = state.currentUser.iban;

    try {
        if (navigator.clipboard?.writeText) {
            await navigator.clipboard.writeText(iban);
        } else {
            const tmp = document.createElement("textarea");
            tmp.value = iban;
            document.body.appendChild(tmp);
            tmp.select();
            document.execCommand("copy");
            tmp.remove();
        }

        notify("IBAN panoya kopyalandı.", "success");
    } catch {
        notify("IBAN kopyalanamadı. Lütfen manuel kopyalayın.", "error");
    }
}

function handleClearReminders() {
    if (!state.currentUser) {
        notify("İşlem için önce giriş yapın.", "error");
        return;
    }

    if (state.reminders.length === 0) {
        notify("Temizlenecek hatırlatma bulunmuyor.", "info");
        return;
    }

    state.reminders = [];
    saveReminders();
    renderReminders();
    notify("Tüm hatırlatmalar temizlendi.", "success");
}

async function handlePasswordChange() {
    if (!state.currentUser) {
        notify("İşlem için önce giriş yapın.", "error");
        return;
    }

    const currentPassword = getInputValue("settings-current-password");
    const newPassword = getInputValue("settings-new-password");
    const confirmPassword = getInputValue("settings-confirm-password");

    if (!currentPassword || !newPassword || !confirmPassword) {
        notify("Şifre alanları zorunludur.", "error");
        return;
    }

    if (newPassword.length < 4) {
        notify("Yeni şifre en az 4 karakter olmalıdır.", "error");
        return;
    }

    if (newPassword !== confirmPassword) {
        notify("Yeni şifre ve tekrar şifresi aynı olmalıdır.", "error");
        return;
    }

    const result = await withBusy("settings-change-password-button", () =>
        postJson(
            "/api/settings/password-change",
            {
                currentPassword,
                newPassword
            },
            "Şifre güncelleniyor..."
        )
    );

    if (!result.ok) {
        notify(result.message, "error");
        return;
    }

    setUser(result.data.account);
    resetInputs(["settings-current-password", "settings-new-password", "settings-confirm-password"]);
    notify("Şifreniz güncellendi.", "success");
}

function handleAddReminder() {
    if (!state.currentUser) {
        notify("İşlem için önce giriş yapın.", "error");
        return;
    }

    if (!state.currentUser.settings?.reminderEnabled) {
        notify("Hatırlatma özelliği ayarlardan kapalı.", "error");
        return;
    }

    const title = getInputValue("reminder-title");
    const reminderDateTime = getInputValue("reminder-datetime");

    if (!title || !reminderDateTime) {
        notify("Hatırlatma başlığı ve zamanı zorunludur.", "error");
        return;
    }

    const when = new Date(reminderDateTime);
    if (Number.isNaN(when.getTime())) {
        notify("Geçerli bir tarih ve saat seçiniz.", "error");
        return;
    }

    if (when.getTime() <= Date.now()) {
        notify("Hatırlatma zamanı gelecekte olmalıdır.", "error");
        return;
    }

    state.reminders.push({
        id: `${Date.now()}_${Math.random().toString(16).slice(2)}`,
        title,
        when: when.toISOString(),
        triggered: false
    });

    state.reminders.sort((a, b) => new Date(a.when).getTime() - new Date(b.when).getTime());
    saveReminders();
    renderReminders();
    resetInputs(["reminder-title", "reminder-datetime"]);
    notify("Hatırlatma eklendi.", "success");
}

function handleReminderListClick(event) {
    const button = event.target.closest("[data-reminder-delete]");
    if (!button) {
        return;
    }

    const reminderId = button.dataset.reminderDelete;
    if (!reminderId) {
        return;
    }

    state.reminders = state.reminders.filter((item) => item.id !== reminderId);
    saveReminders();
    renderReminders();
    notify("Hatırlatma silindi.", "info");
}

function showSection(sectionId, button) {
    document.querySelectorAll(".content-section").forEach((section) => section.classList.remove("active"));
    document.querySelectorAll(".sidebar-item").forEach((item) => item.classList.remove("active"));

    const target = document.getElementById(sectionId);
    if (target) {
        requestAnimationFrame(() => target.classList.add("active"));
    }

    const resolvedButton = button || document.querySelector(`.sidebar-item[onclick*="showSection('${sectionId}'"]`);
    if (resolvedButton) {
        resolvedButton.classList.add("active");
    }

    const titles = {
        accounts: "Hesaplar",
        transfer: "Para Transferi",
        bills: "Fatura Ödeme",
        investments: "Yatırım",
        cards: "Kartlar",
        applications: "Başvurular",
        simulator: "Kredi Simülatörü",
        settings: "Ayarlar"
    };

    setText("page-title", titles[sectionId] || "SOMbank");
}

function togglePrivacy() {
    state.balanceHidden = !state.balanceHidden;
    const icon = document.getElementById("privacy-icon");

    if (state.balanceHidden) {
        icon?.classList.remove("fa-eye");
        icon?.classList.add("fa-eye-slash");
    } else {
        icon?.classList.remove("fa-eye-slash");
        icon?.classList.add("fa-eye");
    }

    renderBalance();
}

function initTheme() {
    applyTheme(localStorage.getItem("abank_theme") === "dark" ? "dark" : "light");
    refreshThemeIcon();
}

function toggleTheme() {
    const nextTheme = document.body.classList.contains("dark-mode") ? "light" : "dark";
    applyTheme(nextTheme);

    if (state.currentUser) {
        const prefs = getUserLocalPreferences(state.currentUser.tcNo);
        prefs.theme = nextTheme;
        saveUserLocalPreferences(state.currentUser.tcNo, prefs);
        setInputValue("settings-theme", nextTheme);
    }

    refreshThemeIcon();
    renderSpendingChart(state.currentUser?.transactions || []);
}

function applyTheme(theme) {
    const normalized = theme === "dark" ? "dark" : "light";
    document.body.classList.toggle("dark-mode", normalized === "dark");
    localStorage.setItem("abank_theme", normalized);
    setInputValue("settings-theme", normalized);
    refreshThemeIcon();
}

function getActiveTheme() {
    return document.body.classList.contains("dark-mode") ? "dark" : "light";
}

function refreshThemeIcon() {
    const icon = document.getElementById("theme-icon");
    if (!icon) {
        return;
    }

    const isDark = document.body.classList.contains("dark-mode");
    icon.classList.toggle("fa-moon", !isDark);
    icon.classList.toggle("fa-sun", isDark);
}

function setUser(user) {
    if (!user) {
        return;
    }

    if (!user.settings) {
        user.settings = {
            email: "",
            address: "",
            notificationsEnabled: true,
            reminderEnabled: true,
            language: "tr-TR"
        };
    }

    state.currentUser = user;

    applyLanguage(user.settings.language);
    const localPrefs = getUserLocalPreferences(user.tcNo);
    applyTheme(localPrefs.theme || getActiveTheme());

    setText("header-username", user.username || "-");
    setText("header-tcno", `T.C: ${maskTcNo(user.tcNo)}`);
    setText("header-avatar", getInitials(user.username));
    setText("dashboard-iban", user.iban || "-");
    setText("profile-phone", formatPhone(user.phone));
    setText("summary-tx-count", String((user.transactions || []).length));
    setText("summary-credit-score", String(Number(user.creditScore || 0)));
    setText("summary-transfer-limit", formatCurrency(Number(user.dailyLimits?.transferLimit || 0)));

    renderBalance();
    renderSummary(user.transactions || []);
    renderTransactions(user.transactions || []);
    renderBillHistory(user.billHistory || []);
    renderInvestments(user.investments || []);
    renderCard(user.card || null);
    renderVirtualCard(user.virtualCard || null);
    renderApplications(user.applications || []);
    renderSpendingChart(user.transactions || []);
    renderSettings(user);

    loadReminders();
    checkReminders();

    updateFilterButtons();
    updateMarketWidget();
}

function renderBalance() {
    const balanceEl = document.getElementById("dashboard-balance");
    if (!balanceEl || !state.currentUser) {
        return;
    }

    balanceEl.textContent = state.balanceHidden ? "••••••" : formatCurrency(state.currentUser.balance);
}

function renderSummary(transactions) {
    const incoming = transactions
        .map((tx) => Number(tx.amount || 0))
        .filter((amount) => amount > 0)
        .reduce((sum, amount) => sum + amount, 0);

    const outgoing = transactions
        .map((tx) => Number(tx.amount || 0))
        .filter((amount) => amount < 0)
        .reduce((sum, amount) => sum + Math.abs(amount), 0);

    setText("summary-incoming", formatCurrency(incoming));
    setText("summary-outgoing", formatCurrency(outgoing));
}

function renderTransactions(transactions) {
    const tbody = document.getElementById("recent-transactions");
    if (!tbody) {
        return;
    }

    const filtered = transactions.filter((tx) => {
        const amount = Number(tx.amount || 0);
        if (state.txFilter === "in") return amount > 0;
        if (state.txFilter === "out") return amount < 0;
        return true;
    });

    tbody.innerHTML = "";

    if (filtered.length === 0) {
        tbody.innerHTML = `
            <tr>
                <td colspan="3" class="px-6 py-8 text-slate-500 text-center">
                    <div class="inline-flex items-center gap-2">
                        <i class="fa-regular fa-folder-open"></i>
                        <span>Henüz işlem bulunmuyor.</span>
                    </div>
                </td>
            </tr>
        `;
        return;
    }

    const fragment = document.createDocumentFragment();
    filtered.forEach((tx) => {
        const amount = Number(tx.amount || 0);
        const amountClass = amount < 0 ? "text-amber-900" : amount > 0 ? "text-amber-700" : "text-amber-700";
        const prefix = amount > 0 ? "+" : "";

        const row = document.createElement("tr");
        row.className = "border-t border-slate-100";
        row.innerHTML = `
            <td class="px-6 py-4">${escapeHtml(tx.note || "-")}</td>
            <td class="px-6 py-4">${escapeHtml(formatDate(tx.date))}</td>
            <td class="px-6 py-4 text-right font-semibold ${amountClass}">${prefix}${formatCurrency(amount)}</td>
        `;
        fragment.appendChild(row);
    });

    tbody.appendChild(fragment);
}

function renderBillHistory(history) {
    const tbody = document.getElementById("bill-history-body");
    if (!tbody) {
        return;
    }

    tbody.innerHTML = "";

    if (!history || history.length === 0) {
        tbody.innerHTML = `
            <tr>
                <td colspan="5" class="px-6 py-8 text-slate-500 text-center">
                    <div class="inline-flex items-center gap-2">
                        <i class="fa-regular fa-file-lines"></i>
                        <span>Fatura geçmişi bulunmuyor.</span>
                    </div>
                </td>
            </tr>
        `;
        return;
    }

    const fragment = document.createDocumentFragment();
    history.forEach((item) => {
        const row = document.createElement("tr");
        row.className = "border-t border-slate-100";
        row.innerHTML = `
            <td class="px-6 py-4">${escapeHtml(item.institution || "-")}</td>
            <td class="px-6 py-4">${escapeHtml(item.subscriberNo || "-")}</td>
            <td class="px-6 py-4">${escapeHtml(item.note || "-")}</td>
            <td class="px-6 py-4">${escapeHtml(formatDate(item.date))}</td>
            <td class="px-6 py-4 text-right font-semibold text-amber-900">-${formatCurrency(Number(item.amount || 0))}</td>
        `;
        fragment.appendChild(row);
    });

    tbody.appendChild(fragment);
}

function renderInvestments(investments) {
    const tbody = document.getElementById("investments-table-body");
    if (!tbody) {
        return;
    }

    tbody.innerHTML = "";

    if (!investments || investments.length === 0) {
        tbody.innerHTML = `
            <tr>
                <td colspan="3" class="px-6 py-8 text-slate-500 text-center">
                    <div class="inline-flex items-center gap-2">
                        <i class="fa-regular fa-chart-bar"></i>
                        <span>Yatırım kaydı yok.</span>
                    </div>
                </td>
            </tr>
        `;
        return;
    }

    const fragment = document.createDocumentFragment();
    investments.forEach((item) => {
        const row = document.createElement("tr");
        row.className = "border-t border-slate-100";
        row.innerHTML = `
            <td class="px-6 py-4">${escapeHtml(item.asset || "-")}</td>
            <td class="px-6 py-4">${formatNumber(item.quantity, 6)}</td>
            <td class="px-6 py-4 text-right font-semibold">${formatCurrency(Number(item.totalAmount || 0))}</td>
        `;
        fragment.appendChild(row);
    });

    tbody.appendChild(fragment);
}

function renderCard(card) {
    if (!card) {
        setText("card-number", "---- ---- ---- ----");
        setText("card-alias-display", "SOMbank Kartim");
        setText("card-owner", "-");
        setText("card-expiry", "--/--");
        setText("card-limit", formatCurrency(0));
        setText("card-used-limit", formatCurrency(0));
        setText("card-available-limit", formatCurrency(0));
        setText("card-debt", formatCurrency(0));
        setText("card-cash-limit", formatCurrency(0));
        setText("card-cash-used", formatCurrency(0));
        setText("card-statement-day", "-");
        setText("card-status", "Pasif");
        setText("card-cvv", "---");
        applyCardSettingsToForm(null);
        setText("card-daily-spent", formatCurrency(0));
        setText("card-daily-remaining", formatCurrency(0));
        return;
    }

    setText("card-number", card.cardNumber || "---- ---- ---- ----");
    setText("card-alias-display", card.alias || "SOMbank Kartim");
    setText("card-owner", state.currentUser?.username || "-");
    setText("card-expiry", card.expiry || "--/--");
    setText("card-limit", formatCurrency(Number(card.limit || 0)));
    setText("card-used-limit", formatCurrency(Number(card.usedLimit || 0)));
    setText("card-available-limit", formatCurrency(Number(card.availableLimit || 0)));
    setText("card-debt", formatCurrency(Number(card.debt || 0)));
    setText("card-cash-limit", formatCurrency(Number(card.cashAdvanceLimit || 0)));
    setText("card-cash-used", formatCurrency(Number(card.cashAdvanceUsed || 0)));
    setText("card-statement-day", String(Number(card.statementDay || 0) || "-"));
    setText("card-status", card.isTemporarilyBlocked ? "Gecici Kapali" : "Aktif");
    setText("card-daily-spent", formatCurrency(Number(card.dailySpentToday || 0)));
    setText("card-daily-remaining", formatCurrency(Number(card.dailySpendingRemaining || 0)));
    setText("card-cvv", card.cvv || "---");
    applyCardSettingsToForm(card);
}

function applyCardSettingsToForm(card) {
    if (!card) {
        setInputValue("card-settings-alias", "");
        setInputValue("card-settings-daily-limit", "");
        setInputValue("card-settings-statement-day", "");
        setCheckboxValue("card-settings-online", true);
        setCheckboxValue("card-settings-contactless", true);
        setCheckboxValue("card-settings-international", false);
        setCheckboxValue("card-settings-cash-advance", true);
        setCheckboxValue("card-settings-auto-debt", false);
        setCheckboxValue("card-settings-notify", true);
        setCheckboxValue("card-settings-frozen", false);
        return;
    }

    setInputValue("card-settings-alias", card.alias || "SOMbank Kartim");
    setInputValue("card-settings-daily-limit", String(Number(card.dailySpendingLimit || 0)));
    setInputValue("card-settings-statement-day", String(Number(card.statementDay || 15)));
    setCheckboxValue("card-settings-online", card.onlinePaymentsEnabled !== false);
    setCheckboxValue("card-settings-contactless", card.contactlessEnabled !== false);
    setCheckboxValue("card-settings-international", card.internationalUsageEnabled === true);
    setCheckboxValue("card-settings-cash-advance", card.cashAdvanceEnabled !== false);
    setCheckboxValue("card-settings-auto-debt", card.autoDebtPaymentEnabled === true);
    setCheckboxValue("card-settings-notify", card.notifyOnTransactions !== false);
    setCheckboxValue("card-settings-frozen", card.isTemporarilyBlocked === true);
}

function renderVirtualCard(card) {
    if (!card) {
        setText("virtual-card-number", "---- ---- ---- ----");
        setText("virtual-card-expiry", "--/--");
        setText("virtual-card-cvv", "---");
        setText("virtual-card-limit", formatCurrency(0));
        setText("virtual-card-spent", formatCurrency(0));
        setText("virtual-card-available", formatCurrency(0));
        setText("virtual-card-status", "Pasif");
        return;
    }

    setText("virtual-card-number", card.cardNumber || "---- ---- ---- ----");
    setText("virtual-card-expiry", card.expiry || "--/--");
    setText("virtual-card-cvv", card.cvv || "---");
    setText("virtual-card-limit", formatCurrency(Number(card.limit || 0)));
    setText("virtual-card-spent", formatCurrency(Number(card.spent || 0)));
    setText("virtual-card-available", formatCurrency(Number(card.available || 0)));
    setText("virtual-card-status", card.isActive ? "Aktif" : "Pasif");
}

function renderApplications(applications) {
    const tbody = document.getElementById("applications-table-body");
    if (!tbody) {
        return;
    }

    tbody.innerHTML = "";

    if (!applications || applications.length === 0) {
        tbody.innerHTML = `
            <tr>
                <td colspan="4" class="px-6 py-8 text-slate-500 text-center">
                    <div class="inline-flex items-center gap-2">
                        <i class="fa-regular fa-rectangle-list"></i>
                        <span>Başvuru bulunmuyor.</span>
                    </div>
                </td>
            </tr>
        `;
        return;
    }

    const fragment = document.createDocumentFragment();
    applications.forEach((app) => {
        const statusClass = app.status === "Onaylandi"
            ? "text-amber-700"
            : app.status === "Reddedildi"
                ? "text-amber-900"
                : "text-amber-700";

        const row = document.createElement("tr");
        row.className = "border-t border-slate-100";
        row.innerHTML = `
            <td class="px-6 py-4">${escapeHtml(app.loanType || "-")}</td>
            <td class="px-6 py-4">${formatCurrency(Number(app.amount || 0))}</td>
            <td class="px-6 py-4 ${statusClass} font-semibold">${escapeHtml(app.status || "-")}</td>
            <td class="px-6 py-4">${escapeHtml(formatDate(app.date))}</td>
        `;
        fragment.appendChild(row);
    });

    tbody.appendChild(fragment);
}

function renderSettings(user) {
    const localPrefs = getUserLocalPreferences(user.tcNo);
    const serverDailyLimit = Number(user.dailyLimits?.transferLimit || 0);
    const preferredDailyLimit = serverDailyLimit > 0 ? serverDailyLimit : (localPrefs.dailyTransferLimit > 0 ? localPrefs.dailyTransferLimit : 100000);

    setInputValue("settings-username", user.username || "");
    setInputValue("settings-phone", user.phone || "");
    setInputValue("settings-email", user.settings?.email || "");
    setInputValue("settings-address", user.settings?.address || "");
    setInputValue("settings-language", user.settings?.language || "tr-TR");
    setInputValue("settings-theme", localPrefs.theme || getActiveTheme());
    setInputValue("settings-daily-transfer-limit", String(preferredDailyLimit));

    setCheckboxValue("settings-notifications", user.settings?.notificationsEnabled !== false);
    setCheckboxValue("settings-reminders", user.settings?.reminderEnabled !== false);
    setCheckboxValue("settings-email-notify", localPrefs.emailNotify !== false);
    setCheckboxValue("settings-sms-notify", localPrefs.smsNotify === true);
    setCheckboxValue("settings-auto-bill-pay", localPrefs.autoBillPay !== false);
    setCheckboxValue("settings-fast-login", localPrefs.fastLogin !== false);

    setText("settings-last-login", formatDate(localPrefs.lastLogin));
    setText("settings-last-sync", formatDate(localPrefs.lastSync));
    setText("settings-device-status", localPrefs.fastLogin === false ? "Standart Koruma" : "Tanımlı Cihaz");
}

function renderSpendingChart(transactions) {
    const canvas = document.getElementById("spending-chart");
    if (!canvas || typeof Chart === "undefined") {
        return;
    }

    const categories = {
        Market: 0,
        Kira: 0,
        "Eğlence": 0,
        Fatura: 0,
        Yatırım: 0,
        "Diğer": 0
    };

    transactions.forEach((tx) => {
        const amount = Number(tx.amount || 0);
        if (amount >= 0) {
            return;
        }

        const note = String(tx.note || "").toLocaleLowerCase("tr-TR");
        const absoluteAmount = Math.abs(amount);

        if (note.includes("market")) {
            categories.Market += absoluteAmount;
            return;
        }

        if (note.includes("kira")) {
            categories.Kira += absoluteAmount;
            return;
        }

        if (note.includes("eğlence") || note.includes("eglence") || note.includes("sinema") || note.includes("restoran")) {
            categories["Eğlence"] += absoluteAmount;
            return;
        }

        if (note.includes("fatura")) {
            categories.Fatura += absoluteAmount;
            return;
        }

        if (note.includes("yatırım") || note.includes("yatirim") || note.includes("fon") || note.includes("usd") || note.includes("eur") || note.includes("altın") || note.includes("altin")) {
            categories.Yatırım += absoluteAmount;
            return;
        }

        categories["Diğer"] += absoluteAmount;
    });

    const labels = Object.keys(categories);
    const values = labels.map((label) => Number(categories[label].toFixed(2)));

    const hasData = values.some((value) => value > 0);
    const chartLabels = hasData ? labels : ["Veri yok"];
    const chartValues = hasData ? values : [1];

    if (state.spendingChart) {
        state.spendingChart.destroy();
    }

    const isDark = document.body.classList.contains("dark-mode");

    state.spendingChart = new Chart(canvas, {
        type: "doughnut",
        data: {
            labels: chartLabels,
            datasets: [
                {
                    data: chartValues,
                    backgroundColor: hasData
                        ? ["#f59e0b", "#fbbf24", "#fcd34d", "#fef08a", "#fde68a", "#fef3c7"]
                        : ["#fef3c7"],
                    borderWidth: 0,
                    hoverOffset: 6
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            animation: {
                duration: 650,
                easing: "easeOutQuart"
            },
            plugins: {
                legend: {
                    position: "bottom",
                    labels: {
                        color: isDark ? "#cbd5e1" : "#334155",
                        boxWidth: 12,
                        boxHeight: 12
                    }
                },
                tooltip: {
                    backgroundColor: isDark ? "rgba(146,64,14,0.92)" : "rgba(255,251,235,0.98)",
                    borderColor: isDark ? "#f59e0b" : "#f59e0b",
                    borderWidth: 1,
                    padding: 12,
                    titleColor: isDark ? "#fffbeb" : "#78350f",
                    bodyColor: isDark ? "#fef3c7" : "#92400e",
                    cornerRadius: 12,
                    callbacks: {
                        label(context) {
                            const label = context.label || "";
                            const value = Number(context.parsed || 0);
                            return `${label}: ${formatCurrency(value)}`;
                        }
                    }
                }
            }
        }
    });
}

function renderReminders() {
    const container = document.getElementById("reminders-list");
    if (!container) {
        return;
    }

    container.innerHTML = "";

    if (!state.reminders.length) {
        container.innerHTML = '<p class="text-xs text-slate-500">Aktif hatırlatma yok.</p>';
        return;
    }

    const fragment = document.createDocumentFragment();
    state.reminders.forEach((item) => {
        const isTriggered = Boolean(item.triggered);

        const row = document.createElement("div");
        row.className = "rounded-xl border border-slate-200 bg-slate-50 px-3 py-2";
        row.innerHTML = `
            <div class="flex items-start justify-between gap-2">
                <div>
                    <p class="text-sm font-semibold text-slate-700">${escapeHtml(item.title)}</p>
                    <p class="text-xs ${isTriggered ? "text-amber-700" : "text-slate-500"}">${isTriggered ? "Tamamlandı" : "Planlandı"} • ${escapeHtml(formatDate(item.when))}</p>
                </div>
                <button data-reminder-delete="${escapeHtml(item.id)}" class="text-slate-400 hover:text-amber-800" title="Sil">
                    <i class="fa-solid fa-trash"></i>
                </button>
            </div>
        `;

        fragment.appendChild(row);
    });

    container.appendChild(fragment);
}

function loadReminders() {
    if (!state.currentUser) {
        state.reminders = [];
        renderReminders();
        return;
    }

    const raw = localStorage.getItem(reminderStorageKey(state.currentUser.tcNo));
    if (!raw) {
        state.reminders = [];
        renderReminders();
        return;
    }

    try {
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) {
            state.reminders = [];
            renderReminders();
            return;
        }

        state.reminders = parsed
            .filter((item) => item && typeof item.id === "string" && typeof item.title === "string" && typeof item.when === "string")
            .map((item) => ({
                id: item.id,
                title: item.title,
                when: item.when,
                triggered: Boolean(item.triggered)
            }))
            .sort((a, b) => new Date(a.when).getTime() - new Date(b.when).getTime());
    } catch {
        state.reminders = [];
    }

    renderReminders();
}

function saveReminders() {
    if (!state.currentUser) {
        return;
    }

    localStorage.setItem(reminderStorageKey(state.currentUser.tcNo), JSON.stringify(state.reminders));
}

function startReminderWatcher() {
    if (state.reminderTimerStarted) {
        return;
    }

    state.reminderTimerStarted = true;
    window.setInterval(checkReminders, 15000);
}

function checkReminders() {
    if (!state.currentUser || !state.reminders.length) {
        return;
    }

    if (!state.currentUser.settings?.reminderEnabled) {
        return;
    }

    const now = Date.now();
    let changed = false;

    state.reminders.forEach((item) => {
        if (item.triggered) {
            return;
        }

        const targetTime = new Date(item.when).getTime();
        if (Number.isNaN(targetTime)) {
            item.triggered = true;
            changed = true;
            return;
        }

        if (targetTime <= now) {
            item.triggered = true;
            changed = true;
            notify(`Hatırlatma: ${item.title}`, "info");
        }
    });

    if (changed) {
        saveReminders();
        renderReminders();
    }
}

function reminderStorageKey(tcNo) {
    return `abank_reminders_${tcNo}`;
}

function localSettingsStorageKey(tcNo) {
    return `abank_local_settings_${tcNo}`;
}

function getDefaultLocalPreferences() {
    return {
        theme: getActiveTheme(),
        dailyTransferLimit: 100000,
        emailNotify: true,
        smsNotify: false,
        autoBillPay: true,
        fastLogin: true,
        lastLogin: new Date().toISOString(),
        lastSync: new Date().toISOString()
    };
}

function getUserLocalPreferences(tcNo) {
    const defaults = getDefaultLocalPreferences();
    if (!tcNo) {
        return defaults;
    }

    const raw = localStorage.getItem(localSettingsStorageKey(tcNo));
    if (!raw) {
        return defaults;
    }

    try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== "object") {
            return defaults;
        }

        return {
            ...defaults,
            ...parsed
        };
    } catch {
        return defaults;
    }
}

function saveUserLocalPreferences(tcNo, prefs) {
    if (!tcNo) {
        return;
    }

    localStorage.setItem(localSettingsStorageKey(tcNo), JSON.stringify({
        ...getDefaultLocalPreferences(),
        ...prefs
    }));
}

function markUserLogin(tcNo) {
    if (!tcNo) {
        return;
    }

    const prefs = getUserLocalPreferences(tcNo);
    prefs.lastLogin = new Date().toISOString();
    prefs.lastSync = prefs.lastSync || prefs.lastLogin;
    saveUserLocalPreferences(tcNo, prefs);
}

function updateFilterButtons() {
    document.querySelectorAll("[data-tx-filter]").forEach((button) => {
        const isActive = button.dataset.txFilter === state.txFilter;
        button.classList.toggle("bg-amber-500", isActive);
        button.classList.toggle("text-amber-950", isActive);
        button.classList.toggle("border-amber-500", isActive);
        button.classList.toggle("bg-white", !isActive);
        button.classList.toggle("text-slate-700", !isActive);
        button.classList.toggle("border-slate-300", !isActive);
    });
}

function updateInvestmentPrice() {
    const asset = getInputValue("investment-asset");
    const price = Number(investmentPrices[asset] || 0);
    setText("investment-unit-price", formatCurrency(price));
}

function updateMarketWidget() {
    setText("market-usd", formatCurrency(marketSnapshot.usd));
    setText("market-eur", formatCurrency(marketSnapshot.eur));
    setText("market-gold", formatCurrency(marketSnapshot.gold));
}

function startMarketPolling() {
    window.setInterval(() => {
        refreshMarketRates();
    }, 30000);
}

async function refreshMarketRates() {
    const result = await getJson("/api/markets", "Piyasa verileri güncelleniyor...", false);
    if (!result.ok || !result.data) {
        return;
    }

    marketSnapshot.usd = Number(result.data.usd || marketSnapshot.usd);
    marketSnapshot.eur = Number(result.data.eur || marketSnapshot.eur);
    marketSnapshot.gold = Number(result.data.gold || marketSnapshot.gold);
    updateMarketWidget();
}

async function restoreSession() {
    const token = localStorage.getItem("abank_token");
    if (!token) {
        clearSessionToken();
        openAuthModal();
        clearUserView();
        return;
    }

    state.authToken = token;
    const result = await getJson("/api/account/me", "Oturum doğrulanıyor...");
    if (!result.ok) {
        clearSessionToken();
        openAuthModal();
        clearUserView();
        return;
    }

    closeAuthModal();
    setUser(result.data);
    if (result.data?.tcNo) {
        localStorage.setItem("abank_tcno", result.data.tcNo);
    }
}

function logout() {
    state.currentUser = null;
    state.authToken = null;
    state.balanceHidden = false;
    state.txFilter = "all";
    state.reminders = [];

    const icon = document.getElementById("privacy-icon");
    icon?.classList.remove("fa-eye-slash");
    icon?.classList.add("fa-eye");

    clearSessionToken();
    openAuthModal();
    clearUserView();
    notify("Çıkış yapıldı.", "info");
}

function clearUserView() {
    setText("header-username", "-");
    setText("header-tcno", "-");
    setText("header-avatar", "?");
    setText("dashboard-balance", formatCurrency(0));
    setText("dashboard-iban", "-");
    setText("profile-phone", "-");
    setText("summary-tx-count", "0");
    setText("summary-incoming", formatCurrency(0));
    setText("summary-outgoing", formatCurrency(0));
    setText("summary-credit-score", "0");
    setText("summary-transfer-limit", formatCurrency(0));

    renderTransactions([]);
    renderBillHistory([]);
    renderInvestments([]);
    renderCard(null);
    renderVirtualCard(null);
    renderApplications([]);
    renderSpendingChart([]);

    setInputValue("settings-username", "");
    setInputValue("settings-phone", "");
    setInputValue("settings-email", "");
    setInputValue("settings-address", "");
    setInputValue("settings-language", "tr-TR");
    setInputValue("settings-theme", getActiveTheme());
    setInputValue("settings-daily-transfer-limit", "100000");
    setCheckboxValue("settings-notifications", true);
    setCheckboxValue("settings-email-notify", true);
    setCheckboxValue("settings-sms-notify", false);
    setCheckboxValue("settings-reminders", true);
    setCheckboxValue("settings-auto-bill-pay", true);
    setCheckboxValue("settings-fast-login", true);

    setText("settings-last-login", "-");
    setText("settings-last-sync", "-");
    setText("settings-device-status", "Güvenli");

    resetLoanSimulation();
    renderReminders();
}

function switchAuthMode(mode) {
    const loginForm = document.getElementById("login-form");
    const registerForm = document.getElementById("register-form");
    const showLogin = document.getElementById("show-login");
    const showRegister = document.getElementById("show-register");
    const authTitle = document.getElementById("auth-title");
    const authSubtitle = document.getElementById("auth-subtitle");

    if (mode === "register") {
        loginForm?.classList.add("hidden");
        registerForm?.classList.remove("hidden");
        showRegister?.classList.add("bg-white");
        showRegister?.classList.add("text-amber-900");
        showRegister?.classList.remove("text-slate-500");
        showLogin?.classList.remove("bg-white");
        showLogin?.classList.remove("text-amber-900");
        showLogin?.classList.add("text-slate-500");
        if (authTitle) authTitle.textContent = "SOMbank Kayıt";
        if (authSubtitle) authSubtitle.textContent = "Kayıt için T.C., telefon ve şifre bilgilerinizi girin.";
    } else {
        registerForm?.classList.add("hidden");
        loginForm?.classList.remove("hidden");
        showLogin?.classList.add("bg-white");
        showLogin?.classList.add("text-amber-900");
        showLogin?.classList.remove("text-slate-500");
        showRegister?.classList.remove("bg-white");
        showRegister?.classList.remove("text-amber-900");
        showRegister?.classList.add("text-slate-500");
        if (authTitle) authTitle.textContent = "SOMbank Giriş";
        if (authSubtitle) authSubtitle.textContent = "Giriş için sadece T.C. Kimlik No ve şifrenizi girin.";
    }

    setAuthMessage("", false);
}

function clearAuthFields() {
    resetInputs([
        "login-tcno",
        "login-password",
        "register-tcno",
        "register-phone",
        "register-password"
    ]);
}

function setAuthMessage(text, isError) {
    const el = document.getElementById("auth-message");
    if (!el) return;
    el.textContent = text;
    el.className = `text-sm mt-4 ${isError ? "text-amber-900" : "text-amber-700"}`;
}

async function withBusy(buttonId, fn) {
    if (state.busy.has(buttonId)) {
        return { ok: false, message: "İşlem devam ediyor..." };
    }

    const button = document.getElementById(buttonId);
    state.busy.add(buttonId);

    if (button) {
        button.disabled = true;
        button.classList.add("opacity-70", "cursor-not-allowed");
    }

    try {
        return await fn();
    } finally {
        state.busy.delete(buttonId);
        if (button) {
            button.disabled = false;
            button.classList.remove("opacity-70", "cursor-not-allowed");
        }
    }
}

function openAuthModal() {
    const modal = document.getElementById("auth-modal");
    modal?.classList.remove("hidden");
    modal?.classList.add("flex");
    switchAuthMode("login");
}

function closeAuthModal() {
    const modal = document.getElementById("auth-modal");
    modal?.classList.add("hidden");
    modal?.classList.remove("flex");
}

function setSessionToken(token) {
    state.authToken = token || null;
    if (state.authToken) {
        localStorage.setItem("abank_token", state.authToken);
    } else {
        localStorage.removeItem("abank_token");
    }
}

function clearSessionToken() {
    state.authToken = null;
    localStorage.removeItem("abank_token");
    localStorage.removeItem("abank_tcno");
}

function invalidateSession(message) {
    clearSessionToken();
    openAuthModal();
    clearUserView();
    if (message) {
        notify(message, "error");
    }
}

function buildAuthHeaders(extraHeaders = {}) {
    const headers = { ...extraHeaders };
    if (state.authToken) {
        headers.Authorization = `Bearer ${state.authToken}`;
    }

    return headers;
}

async function postJson(path, body, loadingText = "İşlem yapılıyor...") {
    showLoading(loadingText);
    try {
        const response = await fetch(`${BASE_URL}${path}`, {
            method: "POST",
            headers: buildAuthHeaders({ "Content-Type": "application/json" }),
            body: JSON.stringify(body)
        });

        const data = await safeJson(response);
        if (response.status === 401) {
            invalidateSession("Oturum süreniz doldu. Lütfen tekrar giriş yapın.");
            return { ok: false, message: "Oturum süresi doldu." };
        }

        if (!response.ok) {
            return { ok: false, message: data?.message || "İşlem başarısız." };
        }

        return { ok: true, data };
    } catch {
        return { ok: false, message: "Sunucuya ulaşılamadı." };
    } finally {
        hideLoading();
    }
}

async function getJson(path, loadingText = "Veriler yükleniyor...", withLoading = true) {
    if (withLoading) {
        showLoading(loadingText);
    }
    try {
        const response = await fetch(`${BASE_URL}${path}`, {
            headers: buildAuthHeaders()
        });
        const data = await safeJson(response);

        if (response.status === 401) {
            invalidateSession("Oturum süreniz doldu. Lütfen tekrar giriş yapın.");
            return { ok: false, message: "Oturum süresi doldu." };
        }

        if (!response.ok) {
            return { ok: false, message: data?.message || "Veri alınamadı." };
        }

        return { ok: true, data };
    } catch {
        return { ok: false, message: "Sunucuya ulaşılamadı." };
    } finally {
        if (withLoading) {
            hideLoading();
        }
    }
}

function showLoading(text = "İşlem yapılıyor...") {
    state.loadingCount += 1;

    const overlay = document.getElementById("loading-overlay");
    if (!overlay) {
        return;
    }

    setText("loading-text", text);
    overlay.classList.remove("hidden");
    overlay.classList.add("flex");
}

function hideLoading() {
    state.loadingCount = Math.max(0, state.loadingCount - 1);
    if (state.loadingCount > 0) {
        return;
    }

    const overlay = document.getElementById("loading-overlay");
    if (!overlay) {
        return;
    }

    overlay.classList.add("hidden");
    overlay.classList.remove("flex");
}

async function safeJson(response) {
    const text = await response.text();
    if (!text) {
        return null;
    }

    try {
        return JSON.parse(text);
    } catch {
        return null;
    }
}

function notify(message, type = "info") {
    if (type !== "error" && state.currentUser?.settings && state.currentUser.settings.notificationsEnabled === false) {
        return;
    }

    const container = document.getElementById("toast-container");
    if (!container) {
        return;
    }

    const toast = document.createElement("div");
    toast.className = "min-w-[260px] max-w-sm rounded-xl px-4 py-3 text-amber-950 shadow-lg opacity-0 translate-y-1 transition-all duration-300 border border-amber-200";

    if (type === "success") {
        toast.classList.add("bg-amber-200");
    } else if (type === "error") {
        toast.classList.add("bg-amber-300");
    } else {
        toast.classList.add("bg-amber-100");
    }

    const title = document.createElement("div");
    title.className = "text-xs uppercase tracking-wide opacity-80";
    title.textContent = type === "success" ? "Başarılı" : type === "error" ? "Hata" : "Bilgi";

    const body = document.createElement("div");
    body.className = "text-sm font-medium mt-1";
    body.textContent = message;

    toast.appendChild(title);
    toast.appendChild(body);
    container.appendChild(toast);

    requestAnimationFrame(() => {
        toast.classList.remove("opacity-0", "translate-y-1");
    });

    window.setTimeout(() => {
        toast.classList.add("opacity-0", "translate-y-1");
        window.setTimeout(() => toast.remove(), 300);
    }, 3000);
}

function calculateLoanPlan(amount, months, monthlyRatePercent) {
    const monthlyRate = monthlyRatePercent / 100;

    let monthlyPayment = 0;
    if (monthlyRate === 0) {
        monthlyPayment = amount / months;
    } else {
        const factor = Math.pow(1 + monthlyRate, months);
        monthlyPayment = amount * ((monthlyRate * factor) / (factor - 1));
    }

    const schedule = [];
    let remaining = amount;
    let totalPayment = 0;
    let totalInterest = 0;

    for (let month = 1; month <= months; month += 1) {
        const interest = roundMoney(remaining * monthlyRate);
        let principal = roundMoney(monthlyPayment - interest);
        let installment = roundMoney(monthlyPayment);

        if (month === months) {
            principal = roundMoney(remaining);
            installment = roundMoney(principal + interest);
        }

        remaining = roundMoney(Math.max(0, remaining - principal));
        totalPayment = roundMoney(totalPayment + installment);
        totalInterest = roundMoney(totalInterest + interest);

        schedule.push({
            month,
            installment,
            principal,
            interest,
            remaining
        });
    }

    return {
        monthlyPayment: roundMoney(monthlyPayment),
        totalPayment,
        totalInterest,
        schedule
    };
}

function renderLoanPlan(schedule) {
    const tbody = document.getElementById("sim-plan-body");
    if (!tbody) {
        return;
    }

    tbody.innerHTML = "";

    if (!schedule || schedule.length === 0) {
        tbody.innerHTML = '<tr><td colspan="5" class="px-6 py-4 text-slate-500">Henüz ödeme planı yok.</td></tr>';
        return;
    }

    const fragment = document.createDocumentFragment();
    schedule.forEach((row) => {
        const tr = document.createElement("tr");
        tr.className = "border-t border-slate-100";
        tr.innerHTML = `
            <td class="px-6 py-4">${row.month}</td>
            <td class="px-6 py-4 font-semibold">${formatCurrency(row.installment)}</td>
            <td class="px-6 py-4 text-amber-700">${formatCurrency(row.principal)}</td>
            <td class="px-6 py-4 text-amber-900">${formatCurrency(row.interest)}</td>
            <td class="px-6 py-4 text-right">${formatCurrency(row.remaining)}</td>
        `;
        fragment.appendChild(tr);
    });

    tbody.appendChild(fragment);
}

function resetLoanSimulation() {
    state.loanSimulation = null;
    setText("sim-selected-type", prettifyLoanType(getInputValue("sim-loan-type") || "Ihtiyac Kredisi"));
    setText("sim-monthly-payment", formatCurrency(0));
    setText("sim-total-payment", formatCurrency(0));
    setText("sim-total-interest", formatCurrency(0));
    setText("sim-first-installment-date", "-");
    setText("sim-plan-note", "Hesaplama sonrası plan burada görünür.");
    renderLoanPlan([]);
}

function prettifyLoanType(value) {
    return String(value || "")
        .replaceAll("Ihtiyac", "İhtiyaç")
        .replaceAll("TasIt", "Taşıt")
        .replaceAll("KOBI", "KOBİ");
}

function mapLoanTypeForApplication(loanType) {
    const allowed = new Set(["Ihtiyac Kredisi", "Konut Kredisi", "TasIt Kredisi", "KOBI Kredisi"]);
    if (allowed.has(loanType)) {
        return loanType;
    }

    return "Ihtiyac Kredisi";
}

function formatInstallmentDate(monthOffset) {
    const date = new Date();
    date.setMonth(date.getMonth() + Number(monthOffset || 0));
    date.setDate(5);

    return new Intl.DateTimeFormat(getLocale(), {
        year: "numeric",
        month: "long",
        day: "2-digit"
    }).format(date);
}

function applyLanguage(language) {
    const normalized = language || "tr-TR";
    document.documentElement.lang = normalized.toLowerCase().startsWith("en") ? "en" : "tr";
}

function getLocale() {
    const userLanguage = state.currentUser?.settings?.language;
    if (userLanguage) {
        return userLanguage;
    }

    return "tr-TR";
}

function formatDate(rawDate) {
    if (!rawDate) {
        return "-";
    }

    const date = new Date(rawDate);
    if (Number.isNaN(date.getTime())) {
        return String(rawDate);
    }

    return new Intl.DateTimeFormat(getLocale(), {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit"
    }).format(date);
}

function setText(id, value) {
    const el = document.getElementById(id);
    if (el) {
        el.textContent = value;
    }
}

function getInputValue(id) {
    const el = document.getElementById(id);
    return (el?.value || "").trim();
}

function setInputValue(id, value) {
    const el = document.getElementById(id);
    if (el) {
        el.value = value;
    }
}

function getCheckboxValue(id) {
    const el = document.getElementById(id);
    return Boolean(el?.checked);
}

function setCheckboxValue(id, checked) {
    const el = document.getElementById(id);
    if (el) {
        el.checked = Boolean(checked);
    }
}

function normalizeDigits(value) {
    return String(value || "").replace(/\D/g, "");
}

function resetInputs(ids) {
    ids.forEach((id) => {
        const el = document.getElementById(id);
        if (el) {
            el.value = "";
        }
    });
}

function toNumber(value) {
    const num = Number.parseFloat(value);
    return Number.isFinite(num) ? num : 0;
}

function roundMoney(value) {
    return Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
}

function formatCurrency(value) {
    return new Intl.NumberFormat(getLocale(), {
        style: "currency",
        currency: "TRY",
        minimumFractionDigits: 2,
        maximumFractionDigits: 2
    }).format(Number(value || 0));
}

function formatNumber(value, maxDigits = 2) {
    return new Intl.NumberFormat(getLocale(), {
        minimumFractionDigits: 0,
        maximumFractionDigits: maxDigits
    }).format(Number(value || 0));
}

function formatPhone(rawPhone) {
    const digits = String(rawPhone || "").replace(/\D/g, "");
    if (digits.length < 10) {
        return rawPhone || "-";
    }

    const d = digits.length === 10 ? digits : digits.slice(-10);
    return `(${d.slice(0, 3)}) ${d.slice(3, 6)} ${d.slice(6, 8)} ${d.slice(8, 10)}`;
}

function maskTcNo(tcNo) {
    const digits = String(tcNo || "").replace(/\D/g, "");
    if (digits.length !== 11) {
        return tcNo || "-";
    }

    return `${digits.slice(0, 3)}******${digits.slice(-2)}`;
}

function getInitials(username) {
    if (!username) {
        return "?";
    }

    return username
        .split(" ")
        .map((part) => part[0])
        .join("")
        .slice(0, 2)
        .toUpperCase();
}

function escapeHtml(value) {
    return String(value)
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#039;");
}
