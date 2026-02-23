using System.Collections.Concurrent;
using System.Globalization;
using System.IdentityModel.Tokens.Jwt;
using System.Security.Claims;
using System.Text;
using System.Text.RegularExpressions;
using BCrypt.Net;
using Microsoft.AspNetCore.Authentication.JwtBearer;
using Microsoft.AspNetCore.Authorization;
using Microsoft.IdentityModel.Tokens;

var builder = WebApplication.CreateBuilder(args);

const string CorsPolicy = "AllowAll";
const string JwtIssuer = "SOMbank";
const string JwtAudience = "SOMbank.Client";
var jwtKey = builder.Configuration["Jwt:Key"];
if (string.IsNullOrWhiteSpace(jwtKey))
{
    jwtKey = "SOMbank-Dev-Only-Ultra-Secret-Key-2026-Change-Immediately";
}

var jwtSigningKey = new SymmetricSecurityKey(Encoding.UTF8.GetBytes(jwtKey));

builder.Services.AddCors(options =>
{
    options.AddPolicy(CorsPolicy, policy =>
    {
        policy.AllowAnyOrigin()
            .AllowAnyHeader()
            .AllowAnyMethod();
    });
});

builder.Services
    .AddAuthentication(JwtBearerDefaults.AuthenticationScheme)
    .AddJwtBearer(options =>
    {
        options.TokenValidationParameters = new TokenValidationParameters
        {
            ValidateIssuer = true,
            ValidateAudience = true,
            ValidateIssuerSigningKey = true,
            ValidateLifetime = true,
            ClockSkew = TimeSpan.FromSeconds(30),
            ValidIssuer = JwtIssuer,
            ValidAudience = JwtAudience,
            IssuerSigningKey = jwtSigningKey
        };
    });

builder.Services.AddAuthorization();

var users = new ConcurrentDictionary<string, BankUser>(StringComparer.OrdinalIgnoreCase);
builder.Services.AddSingleton(users);
builder.Services.AddSingleton<MarketState>();
builder.Services.AddHostedService<MarketAndInterestWorker>();

var app = builder.Build();

app.UseCors(CorsPolicy);
app.UseDefaultFiles();
app.UseStaticFiles();
app.UseAuthentication();
app.UseAuthorization();

var logger = app.Logger;
var supportedInstitutions = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
{
    "Elektrik",
    "Su",
    "Dogalgaz",
    "Internet",
    "İnternet",
    "Telefon"
};

var allowedLoanTypes = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
{
    "Ihtiyac Kredisi",
    "Konut Kredisi",
    "TasIt Kredisi",
    "KOBI Kredisi"
};

var tcNoRegex = new Regex(@"^\d{11}$", RegexOptions.Compiled);
var phoneRegex = new Regex(@"^(?:\d{10}|0\d{10}|90\d{10})$", RegexOptions.Compiled);
var ibanRegex = new Regex(@"^TR\d{2}[0-9A-Z]{10,30}$", RegexOptions.Compiled);

SeedDemoUser();

app.MapPost("/api/auth/register", (RegisterRequest request) =>
{
    var tcNo = NormalizeDigits(request.TcNo);
    var phone = NormalizeDigits(request.Phone);
    var password = request.Password?.Trim() ?? string.Empty;

    if (!IsValidTcNo(tcNo) || !IsValidPhone(phone) || !IsValidPassword(password))
    {
        return Results.BadRequest(new { message = "T.C. kimlik no, telefon ve sifre zorunludur." });
    }

    if (users.ContainsKey(tcNo))
    {
        logger.LogWarning("Duplicate register attempt for TcNo {TcNo}", tcNo);
        return Results.BadRequest(new { message = "Bu T.C. kimlik numarasi ile zaten hesap var." });
    }

    var user = new BankUser
    {
        Username = string.IsNullOrWhiteSpace(request.Username) ? $"Musteri {tcNo[^4..]}" : request.Username.Trim(),
        TcNo = tcNo,
        Phone = phone,
        PasswordHash = HashPassword(password),
        Balance = 17500m,
        Iban = BuildIban(),
        Card = BuildCard(),
        Settings = BuildDefaultSettings(),
        DailyTransferLimit = 120000m,
        TransferUsageDate = DateOnly.FromDateTime(DateTime.Now),
        TransferUsedToday = 0m
    };

    user.Transactions.Add(new Transaction
    {
        Note = "Hesap acilis bakiyesi",
        Amount = 17500m,
        Date = DateTime.Now
    });

    AddAudit(user, "register", "Yeni musteri hesabi olusturuldu.", "information");

    if (!users.TryAdd(tcNo, user))
    {
        logger.LogCritical("Failed to insert newly created user for TcNo {TcNo}", tcNo);
        return Results.BadRequest(new { message = "Kayit olusturulamadi." });
    }

    logger.LogInformation("User registered successfully for TcNo {TcNo}", tcNo);

    return Results.Ok(new
    {
        message = "Kayit basarili.",
        token = CreateJwtToken(user),
        account = ToResponse(user)
    });
});

app.MapPost("/api/auth/login", (LoginRequest request) =>
{
    var tcNo = NormalizeDigits(request.TcNo);
    var password = request.Password?.Trim() ?? string.Empty;

    if (!IsValidTcNo(tcNo) || string.IsNullOrWhiteSpace(password))
    {
        return Results.BadRequest(new { message = "Giris bilgileri eksik veya gecersiz." });
    }

    if (!users.TryGetValue(tcNo, out var user))
    {
        logger.LogWarning("Login failed: user not found for TcNo {TcNo}", tcNo);
        return Results.BadRequest(new { message = "Kullanici bulunamadi." });
    }

    if (!VerifyPassword(password, user.PasswordHash))
    {
        logger.LogWarning("Login failed: invalid credential for TcNo {TcNo}", tcNo);
        return Results.BadRequest(new { message = "T.C. kimlik no veya sifre hatali." });
    }

    AddAudit(user, "login", "Kullanici basariyla giris yapti.", "information");
    logger.LogInformation("Login success for TcNo {TcNo}", tcNo);

    return Results.Ok(new
    {
        message = "Giris basarili.",
        token = CreateJwtToken(user),
        account = ToResponse(user)
    });
});

app.MapGet("/api/markets", (MarketState marketState) =>
{
    lock (marketState.SyncRoot)
    {
        return Results.Ok(new
        {
            usd = marketState.UsdTry,
            eur = marketState.EurTry,
            gold = marketState.GoldTry,
            updatedAt = marketState.UpdatedAt.ToString("yyyy-MM-dd HH:mm:ss")
        });
    }
});

app.MapGet("/health", (ConcurrentDictionary<string, BankUser> store, MarketState marketState) =>
{
    decimal usd;
    decimal eur;
    decimal gold;
    DateTime updatedAt;

    lock (marketState.SyncRoot)
    {
        usd = marketState.UsdTry;
        eur = marketState.EurTry;
        gold = marketState.GoldTry;
        updatedAt = marketState.UpdatedAt;
    }

    return Results.Ok(new
    {
        status = "healthy",
        users = store.Count,
        memoryMb = Math.Round(GC.GetTotalMemory(false) / 1024d / 1024d, 2),
        serverTimeUtc = DateTime.UtcNow.ToString("yyyy-MM-dd HH:mm:ss"),
        market = new
        {
            usd,
            eur,
            gold,
            updatedAt = updatedAt.ToString("yyyy-MM-dd HH:mm:ss")
        }
    });
});

var secureApi = app.MapGroup("/api");
secureApi.RequireAuthorization();

secureApi.MapGet("/account/me", (ClaimsPrincipal principal) =>
{
    if (!TryGetAuthenticatedUser(principal, out var user, out _))
    {
        return Results.Unauthorized();
    }

    return Results.Ok(ToResponse(user));
});

secureApi.MapGet("/account/statement", (ClaimsPrincipal principal, DateTime? from, DateTime? to) =>
{
    if (!TryGetAuthenticatedUser(principal, out var user, out _))
    {
        return Results.Unauthorized();
    }

    var fromDate = (from ?? DateTime.Today.AddMonths(-1)).Date;
    var toDate = (to ?? DateTime.Now).Date.AddDays(1).AddTicks(-1);

    if (fromDate > toDate)
    {
        return Results.BadRequest(new { message = "Tarih araligi gecersiz." });
    }

    var rangeTransactions = user.Transactions
        .Where(tx => tx.Date >= fromDate && tx.Date <= toDate)
        .OrderByDescending(tx => tx.Date)
        .ToList();

    var incoming = rangeTransactions.Where(tx => tx.Amount > 0).Sum(tx => tx.Amount);
    var outgoing = rangeTransactions.Where(tx => tx.Amount < 0).Sum(tx => Math.Abs(tx.Amount));

    return Results.Ok(new
    {
        from = fromDate.ToString("yyyy-MM-dd"),
        to = toDate.ToString("yyyy-MM-dd"),
        summary = new
        {
            incoming,
            outgoing,
            net = incoming - outgoing
        },
        transactions = rangeTransactions.Select(tx => new
        {
            note = tx.Note,
            amount = tx.Amount,
            date = tx.Date.ToString("yyyy-MM-dd HH:mm:ss")
        })
    });
});

secureApi.MapPost("/account/transfer", (ClaimsPrincipal principal, TransferRequest request) =>
{
    if (!TryGetAuthenticatedUser(principal, out var sender, out var senderTcNo))
    {
        return Results.Unauthorized();
    }

    var toIban = NormalizeIban(request.ToIban);

    if (!IsValidIban(toIban))
    {
        return Results.BadRequest(new { message = "Gecerli bir alici IBAN giriniz." });
    }

    if (request.Amount <= 0)
    {
        return Results.BadRequest(new { message = "Tutar sifirdan buyuk olmali." });
    }

    if (string.Equals(toIban, NormalizeIban(sender.Iban), StringComparison.Ordinal))
    {
        return Results.BadRequest(new { message = "Kendi hesabiniza transfer yapamazsiniz." });
    }

    var receiverEntry = users.FirstOrDefault(entry =>
        string.Equals(NormalizeIban(entry.Value.Iban), toIban, StringComparison.Ordinal));

    var hasReceiver = !string.IsNullOrWhiteSpace(receiverEntry.Key);
    var receiver = hasReceiver ? receiverEntry.Value : null;

    var now = DateTime.Now;
    var fee = CalculateTransferFee(request.Amount, now, hasReceiver);
    var totalDebit = request.Amount + fee;
    var note = string.IsNullOrWhiteSpace(request.Note) ? "Para transferi" : request.Note.Trim();

    try
    {
        if (hasReceiver && receiver is not null)
        {
            var first = string.Compare(senderTcNo, receiverEntry.Key, StringComparison.Ordinal) <= 0 ? sender : receiver;
            var second = ReferenceEquals(first, sender) ? receiver : sender;

            lock (first.SyncRoot)
            {
                lock (second.SyncRoot)
                {
                    ResetDailyTransferWindowIfNeeded(sender, now);

                    if (sender.TransferUsedToday + request.Amount > sender.DailyTransferLimit)
                    {
                        logger.LogWarning("Transfer blocked by daily limit for TcNo {TcNo}", senderTcNo);
                        return Results.BadRequest(new { message = "Gunluk transfer limitiniz asildi." });
                    }

                    if (sender.Balance < totalDebit)
                    {
                        logger.LogWarning("Transfer denied by insufficient balance for TcNo {TcNo}", senderTcNo);
                        return Results.BadRequest(new { message = "Yetersiz bakiye." });
                    }

                    sender.Balance -= totalDebit;
                    sender.TransferUsedToday += request.Amount;

                    sender.Transactions.Add(new Transaction
                    {
                        Note = note,
                        Amount = -request.Amount,
                        Date = now
                    });

                    if (fee > 0)
                    {
                        sender.Transactions.Add(new Transaction
                        {
                            Note = "EFT/FAST ucreti",
                            Amount = -fee,
                            Date = now
                        });
                    }

                    receiver.Balance += request.Amount;
                    receiver.Transactions.Add(new Transaction
                    {
                        Note = $"{sender.Username} hesabindan gelen transfer",
                        Amount = request.Amount,
                        Date = now
                    });

                    AddAudit(sender, "transfer", $"{request.Amount.ToString("F2", CultureInfo.InvariantCulture)} TL transfer yapildi. Ucret: {fee.ToString("F2", CultureInfo.InvariantCulture)} TL", "information");
                    AddAudit(receiver, "incoming-transfer", $"{request.Amount.ToString("F2", CultureInfo.InvariantCulture)} TL geldi.", "information");
                }
            }
        }
        else
        {
            lock (sender.SyncRoot)
            {
                ResetDailyTransferWindowIfNeeded(sender, now);

                if (sender.TransferUsedToday + request.Amount > sender.DailyTransferLimit)
                {
                    logger.LogWarning("External transfer blocked by daily limit for TcNo {TcNo}", senderTcNo);
                    return Results.BadRequest(new { message = "Gunluk transfer limitiniz asildi." });
                }

                if (sender.Balance < totalDebit)
                {
                    logger.LogWarning("External transfer denied by insufficient balance for TcNo {TcNo}", senderTcNo);
                    return Results.BadRequest(new { message = "Yetersiz bakiye." });
                }

                sender.Balance -= totalDebit;
                sender.TransferUsedToday += request.Amount;

                sender.Transactions.Add(new Transaction
                {
                    Note = note,
                    Amount = -request.Amount,
                    Date = now
                });

                if (fee > 0)
                {
                    sender.Transactions.Add(new Transaction
                    {
                        Note = "EFT/FAST ucreti",
                        Amount = -fee,
                        Date = now
                    });
                }

                AddAudit(sender, "transfer", $"Dis banka IBAN'ina {request.Amount.ToString("F2", CultureInfo.InvariantCulture)} TL transfer yapildi.", "information");
            }
        }
    }
    catch (Exception ex)
    {
        logger.LogCritical(ex, "Transfer processing failed for TcNo {TcNo}", senderTcNo);
        return Results.Problem("Transfer sirasinda beklenmeyen bir hata olustu.");
    }

    logger.LogInformation(
        "Transfer success from {SenderTcNo} to {ToIban}. Amount={Amount}, Fee={Fee}, Internal={Internal}",
        senderTcNo,
        toIban,
        request.Amount,
        fee,
        hasReceiver);

    return Results.Ok(new
    {
        message = "Transfer basarili.",
        fee,
        account = ToResponse(sender)
    });
});

secureApi.MapPost("/account/bill-payment", (ClaimsPrincipal principal, BillPaymentRequest request) =>
{
    if (!TryGetAuthenticatedUser(principal, out var user, out var tcNo))
    {
        return Results.Unauthorized();
    }

    var institution = request.Institution?.Trim() ?? string.Empty;
    var subscriberNo = request.SubscriberNo?.Trim() ?? string.Empty;

    if (!supportedInstitutions.Contains(institution))
    {
        return Results.BadRequest(new { message = "Desteklenmeyen kurum secildi." });
    }

    if (subscriberNo.Length < 4)
    {
        return Results.BadRequest(new { message = "Gecerli bir abone numarasi giriniz." });
    }

    if (request.Amount <= 0)
    {
        return Results.BadRequest(new { message = "Tutar sifirdan buyuk olmali." });
    }

    lock (user.SyncRoot)
    {
        if (user.Balance < request.Amount)
        {
            logger.LogWarning("Bill payment denied for TcNo {TcNo}: insufficient balance", tcNo);
            return Results.BadRequest(new { message = "Yetersiz bakiye." });
        }

        var note = string.IsNullOrWhiteSpace(request.Note)
            ? $"{institution} faturasi - Abone {subscriberNo}"
            : request.Note.Trim();

        user.Balance -= request.Amount;
        user.Transactions.Add(new Transaction
        {
            Note = note,
            Amount = -request.Amount,
            Date = DateTime.Now
        });

        user.BillHistory.Add(new BillPaymentHistory
        {
            Institution = institution,
            SubscriberNo = subscriberNo,
            Amount = request.Amount,
            Note = note,
            Date = DateTime.Now
        });

        AddAudit(user, "bill-payment", $"{institution} faturasi odendi.", "information");
    }

    return Results.Ok(new
    {
        message = "Fatura odemesi basarili.",
        account = ToResponse(user)
    });
});

secureApi.MapPost("/investments/buy", (ClaimsPrincipal principal, InvestmentRequest request) =>
{
    if (!TryGetAuthenticatedUser(principal, out var user, out _))
    {
        return Results.Unauthorized();
    }

    var asset = request.Asset?.Trim() ?? string.Empty;

    if (string.IsNullOrWhiteSpace(asset))
    {
        return Results.BadRequest(new { message = "Yatirim araci seciniz." });
    }

    if (request.Amount <= 0 || request.UnitPrice <= 0)
    {
        return Results.BadRequest(new { message = "Yatirim tutari veya birim fiyat gecersiz." });
    }

    lock (user.SyncRoot)
    {
        if (user.Balance < request.Amount)
        {
            return Results.BadRequest(new { message = "Yetersiz bakiye." });
        }

        var quantity = request.Amount / request.UnitPrice;

        user.Balance -= request.Amount;
        user.Investments.Add(new InvestmentPosition
        {
            Asset = asset,
            UnitPrice = request.UnitPrice,
            Quantity = decimal.Round(quantity, 6),
            TotalAmount = request.Amount,
            Date = DateTime.Now
        });

        user.Transactions.Add(new Transaction
        {
            Note = $"Yatirim alimi - {asset}",
            Amount = -request.Amount,
            Date = DateTime.Now
        });

        AddAudit(user, "investment-buy", $"{asset} icin yatirim islemi yapildi.", "information");
    }

    return Results.Ok(new
    {
        message = "Yatirim islemi basariyla tamamlandi.",
        account = ToResponse(user)
    });
});

secureApi.MapPost("/cards/limit-increase", (ClaimsPrincipal principal, CardLimitIncreaseRequest request) =>
{
    if (!TryGetAuthenticatedUser(principal, out var user, out _))
    {
        return Results.Unauthorized();
    }

    if (request.Amount <= 0 || request.Amount > 500000m)
    {
        return Results.BadRequest(new { message = "Limit artis tutari gecersiz." });
    }

    lock (user.SyncRoot)
    {
        if (user.Card.Limit + request.Amount > 1000000m)
        {
            return Results.BadRequest(new { message = "Kart limiti azami degeri asamaz." });
        }

        user.Card.Limit += request.Amount;
        user.Transactions.Add(new Transaction
        {
            Note = "Kart limiti arttirildi",
            Amount = 0m,
            Date = DateTime.Now
        });

        AddAudit(user, "card-limit-increase", $"Kart limiti {request.Amount.ToString("F2", CultureInfo.InvariantCulture)} TL arttirildi.", "information");
    }

    return Results.Ok(new
    {
        message = "Kart limiti guncellendi.",
        account = ToResponse(user)
    });
});

secureApi.MapPost("/cards/debt-payment", (ClaimsPrincipal principal, CardDebtPaymentRequest request) =>
{
    if (!TryGetAuthenticatedUser(principal, out var user, out _))
    {
        return Results.Unauthorized();
    }

    if (request.Amount <= 0)
    {
        return Results.BadRequest(new { message = "Odeme tutari gecersiz." });
    }

    lock (user.SyncRoot)
    {
        if (user.Card.Debt <= 0)
        {
            return Results.BadRequest(new { message = "Odenecek kart borcu bulunmuyor." });
        }

        if (request.Amount > user.Card.Debt)
        {
            return Results.BadRequest(new { message = "Tutar kart borcundan buyuk olamaz." });
        }

        if (request.Amount > user.Balance)
        {
            return Results.BadRequest(new { message = "Vadesiz hesap bakiyesi yetersiz." });
        }

        user.Balance -= request.Amount;
        user.Card.Debt -= request.Amount;
        user.Card.UsedLimit = decimal.Max(0m, user.Card.UsedLimit - request.Amount);
        user.Card.CashAdvanceUsed = decimal.Max(0m, user.Card.CashAdvanceUsed - request.Amount);

        user.Transactions.Add(new Transaction
        {
            Note = "Kart borcu odemesi",
            Amount = -request.Amount,
            Date = DateTime.Now
        });

        AddAudit(user, "card-debt-payment", $"Kart borcu icin {request.Amount.ToString("F2", CultureInfo.InvariantCulture)} TL odendi.", "information");
    }

    return Results.Ok(new
    {
        message = "Kart borcu odemesi basarili.",
        account = ToResponse(user)
    });
});

secureApi.MapPost("/cards/cash-advance", (ClaimsPrincipal principal, CardCashAdvanceRequest request) =>
{
    if (!TryGetAuthenticatedUser(principal, out var user, out _))
    {
        return Results.Unauthorized();
    }

    if (request.Amount <= 0)
    {
        return Results.BadRequest(new { message = "Nakit avans tutari gecersiz." });
    }

    lock (user.SyncRoot)
    {
        if (user.Card.IsTemporarilyBlocked)
        {
            return Results.BadRequest(new { message = "Kartiniz gecici olarak kullanima kapali." });
        }

        if (!user.Card.CashAdvanceEnabled)
        {
            return Results.BadRequest(new { message = "Nakit avans ozelligi kart ayarlarinda kapali." });
        }

        ResetCardDailySpendingWindowIfNeeded(user, DateTime.Now);

        if (user.Card.DailySpentToday + request.Amount > user.Card.DailySpendingLimit)
        {
            return Results.BadRequest(new { message = "Gunluk kart harcama limitiniz asiliyor." });
        }

        var availableCardLimit = decimal.Max(0m, user.Card.Limit - user.Card.UsedLimit);
        var remainingCashAdvance = decimal.Max(0m, user.Card.CashAdvanceLimit - user.Card.CashAdvanceUsed);
        var fee = decimal.Round(request.Amount * 0.03m, 2);
        var debtIncrease = request.Amount + fee;

        if (request.Amount > remainingCashAdvance)
        {
            return Results.BadRequest(new { message = "Nakit avans limiti yetersiz." });
        }

        if (debtIncrease > availableCardLimit)
        {
            return Results.BadRequest(new { message = "Kart limitiniz nakit avans icin yetersiz." });
        }

        user.Card.UsedLimit += debtIncrease;
        user.Card.Debt += debtIncrease;
        user.Card.CashAdvanceUsed += request.Amount;
        user.Card.DailySpentToday += request.Amount;
        user.Balance += request.Amount;

        user.Transactions.Add(new Transaction
        {
            Note = "Nakit avans kullanimi",
            Amount = request.Amount,
            Date = DateTime.Now
        });

        user.Transactions.Add(new Transaction
        {
            Note = "Nakit avans masrafi",
            Amount = -fee,
            Date = DateTime.Now
        });

        AddAudit(user, "cash-advance", $"{request.Amount.ToString("F2", CultureInfo.InvariantCulture)} TL nakit avans kullanildi.", "information");
    }

    return Results.Ok(new
    {
        message = "Nakit avans hesaba aktarildi.",
        account = ToResponse(user)
    });
});

secureApi.MapPost("/cards/settings/update", (ClaimsPrincipal principal, UpdateCardSettingsRequest request) =>
{
    if (!TryGetAuthenticatedUser(principal, out var user, out _))
    {
        return Results.Unauthorized();
    }

    if (request.Alias is not null && request.Alias.Trim().Length > 40)
    {
        return Results.BadRequest(new { message = "Kart takma adi en fazla 40 karakter olabilir." });
    }

    if (request.StatementDay.HasValue && (request.StatementDay.Value < 1 || request.StatementDay.Value > 28))
    {
        return Results.BadRequest(new { message = "Ekstre kesim gunu 1 ile 28 arasinda olmalidir." });
    }

    if (request.DailySpendingLimit.HasValue && request.DailySpendingLimit.Value <= 0)
    {
        return Results.BadRequest(new { message = "Gunluk kart harcama limiti sifirdan buyuk olmalidir." });
    }

    lock (user.SyncRoot)
    {
        if (request.DailySpendingLimit.HasValue && request.DailySpendingLimit.Value > user.Card.Limit)
        {
            return Results.BadRequest(new { message = "Gunluk kart harcama limiti kart limitinden buyuk olamaz." });
        }

        if (request.CashAdvanceEnabled.HasValue)
        {
            user.Card.CashAdvanceEnabled = request.CashAdvanceEnabled.Value;
        }

        if (request.IsTemporarilyBlocked.HasValue)
        {
            user.Card.IsTemporarilyBlocked = request.IsTemporarilyBlocked.Value;
        }

        if (request.OnlinePaymentsEnabled.HasValue)
        {
            user.Card.OnlinePaymentsEnabled = request.OnlinePaymentsEnabled.Value;
        }

        if (request.ContactlessEnabled.HasValue)
        {
            user.Card.ContactlessEnabled = request.ContactlessEnabled.Value;
        }

        if (request.InternationalUsageEnabled.HasValue)
        {
            user.Card.InternationalUsageEnabled = request.InternationalUsageEnabled.Value;
        }

        if (request.AutoDebtPaymentEnabled.HasValue)
        {
            user.Card.AutoDebtPaymentEnabled = request.AutoDebtPaymentEnabled.Value;
        }

        if (request.NotifyOnTransactions.HasValue)
        {
            user.Card.NotifyOnTransactions = request.NotifyOnTransactions.Value;
        }

        if (request.DailySpendingLimit.HasValue)
        {
            user.Card.DailySpendingLimit = request.DailySpendingLimit.Value;
        }

        if (request.StatementDay.HasValue)
        {
            user.Card.StatementDay = request.StatementDay.Value;
        }

        if (request.Alias is not null)
        {
            var alias = request.Alias.Trim();
            user.Card.Alias = string.IsNullOrWhiteSpace(alias) ? "SOMbank Kartim" : alias;
        }

        user.Transactions.Add(new Transaction
        {
            Note = "Kart ayarlari guncellendi",
            Amount = 0m,
            Date = DateTime.Now
        });

        AddAudit(user, "card-settings-update", "Kart ayarlari guncellendi.", "information");
    }

    return Results.Ok(new
    {
        message = "Kart ayarlari kaydedildi.",
        account = ToResponse(user)
    });
});

secureApi.MapPost("/cards/virtual/create", (ClaimsPrincipal principal, VirtualCardCreateRequest request) =>
{
    if (!TryGetAuthenticatedUser(principal, out var user, out _))
    {
        return Results.Unauthorized();
    }

    if (request.Limit <= 0)
    {
        return Results.BadRequest(new { message = "Sanal kart limiti gecersiz." });
    }

    lock (user.SyncRoot)
    {
        user.VirtualCard ??= BuildVirtualCard();
        user.VirtualCard.Limit = request.Limit;
        user.VirtualCard.IsActive = true;
        user.VirtualCard.UpdatedAt = DateTime.Now;

        AddAudit(user, "virtual-card", $"Sanal kart olusturuldu/guncellendi. Limit: {request.Limit.ToString("F2", CultureInfo.InvariantCulture)}", "information");
    }

    return Results.Ok(new
    {
        message = "Sanal kart hazir.",
        account = ToResponse(user)
    });
});

secureApi.MapPost("/cards/virtual/spend", (ClaimsPrincipal principal, VirtualCardSpendRequest request) =>
{
    if (!TryGetAuthenticatedUser(principal, out var user, out _))
    {
        return Results.Unauthorized();
    }

    if (request.Amount <= 0)
    {
        return Results.BadRequest(new { message = "Sanal kart islem tutari gecersiz." });
    }

    lock (user.SyncRoot)
    {
        if (!user.Card.OnlinePaymentsEnabled)
        {
            return Results.BadRequest(new { message = "Kartinizda internet harcamalari kapali." });
        }

        if (user.VirtualCard is null || !user.VirtualCard.IsActive)
        {
            return Results.BadRequest(new { message = "Aktif sanal kart bulunmuyor." });
        }

        if (user.VirtualCard.Spent + request.Amount > user.VirtualCard.Limit)
        {
            return Results.BadRequest(new { message = "Sanal kart limitiniz yetersiz." });
        }

        if (user.Balance < request.Amount)
        {
            return Results.BadRequest(new { message = "Sanal kart islemi icin bakiye yetersiz." });
        }

        user.Balance -= request.Amount;
        user.VirtualCard.Spent += request.Amount;
        user.VirtualCard.UpdatedAt = DateTime.Now;

        user.Transactions.Add(new Transaction
        {
            Note = "Sanal kart harcamasi",
            Amount = -request.Amount,
            Date = DateTime.Now
        });

        AddAudit(user, "virtual-card-spend", $"Sanal kart ile {request.Amount.ToString("F2", CultureInfo.InvariantCulture)} TL harcama yapildi.", "information");
    }

    return Results.Ok(new
    {
        message = "Sanal kart islemi basarili.",
        account = ToResponse(user)
    });
});

secureApi.MapPost("/applications/loan", (ClaimsPrincipal principal, LoanApplicationRequest request) =>
{
    if (!TryGetAuthenticatedUser(principal, out var user, out var tcNo))
    {
        return Results.Unauthorized();
    }

    var loanType = request.LoanType?.Trim() ?? string.Empty;

    if (!allowedLoanTypes.Contains(loanType))
    {
        return Results.BadRequest(new { message = "Gecerli bir basvuru tipi seciniz." });
    }

    if (request.Amount <= 0 || request.Months <= 0)
    {
        return Results.BadRequest(new { message = "Kredi tutari ve vade gecersiz." });
    }

    var creditScore = CalculateCreditScore(user);

    string status;
    if (creditScore >= 740 && request.Amount <= user.Balance * 20m)
    {
        status = "Onaylandi";
    }
    else if (creditScore >= 620)
    {
        status = "On Inceleme";
    }
    else
    {
        status = "Reddedildi";
    }

    lock (user.SyncRoot)
    {
        user.Applications.Add(new LoanApplication
        {
            Id = Guid.NewGuid().ToString("N"),
            LoanType = loanType,
            Amount = request.Amount,
            Months = request.Months,
            Status = status,
            Date = DateTime.Now
        });

        user.Transactions.Add(new Transaction
        {
            Note = $"{loanType} basvurusu olusturuldu",
            Amount = 0m,
            Date = DateTime.Now
        });

        AddAudit(user, "loan-application", $"{loanType} basvurusu durumu: {status}. Skor: {creditScore}", status == "Reddedildi" ? "warning" : "information");
    }

    if (status == "Reddedildi")
    {
        logger.LogWarning("Loan application rejected for TcNo {TcNo}. Score={Score}", tcNo, creditScore);
    }
    else
    {
        logger.LogInformation("Loan application processed for TcNo {TcNo}. Status={Status}, Score={Score}", tcNo, status, creditScore);
    }

    return Results.Ok(new
    {
        message = "Basvurunuz alindi.",
        account = ToResponse(user)
    });
});

secureApi.MapPost("/settings/update", (ClaimsPrincipal principal, UpdateSettingsRequest request) =>
{
    if (!TryGetAuthenticatedUser(principal, out var user, out _))
    {
        return Results.Unauthorized();
    }

    var phone = NormalizeDigits(request.Phone);

    if (!string.IsNullOrWhiteSpace(request.Phone) && !IsValidPhone(phone))
    {
        return Results.BadRequest(new { message = "Telefon formati gecersiz." });
    }

    lock (user.SyncRoot)
    {
        if (!string.IsNullOrWhiteSpace(request.Username))
        {
            user.Username = request.Username.Trim();
        }

        if (!string.IsNullOrWhiteSpace(phone))
        {
            user.Phone = phone;
        }

        user.Settings.Email = request.Email?.Trim() ?? string.Empty;
        user.Settings.Address = request.Address?.Trim() ?? string.Empty;
        user.Settings.NotificationsEnabled = request.NotificationsEnabled;
        user.Settings.ReminderEnabled = request.ReminderEnabled;
        user.Settings.Language = string.IsNullOrWhiteSpace(request.Language) ? "tr-TR" : request.Language.Trim();

        if (request.DailyTransferLimit.HasValue && request.DailyTransferLimit.Value > 0)
        {
            user.DailyTransferLimit = request.DailyTransferLimit.Value;
        }

        user.Transactions.Add(new Transaction
        {
            Note = "Profil ayarlari guncellendi",
            Amount = 0m,
            Date = DateTime.Now
        });

        AddAudit(user, "settings-update", "Profil ayarlari guncellendi.", "information");
    }

    return Results.Ok(new
    {
        message = "Ayarlar kaydedildi.",
        account = ToResponse(user)
    });
});

secureApi.MapPost("/settings/password-change", (ClaimsPrincipal principal, ChangePasswordRequest request) =>
{
    if (!TryGetAuthenticatedUser(principal, out var user, out var tcNo))
    {
        return Results.Unauthorized();
    }

    var currentPassword = request.CurrentPassword?.Trim() ?? string.Empty;
    var newPassword = request.NewPassword?.Trim() ?? string.Empty;

    if (string.IsNullOrWhiteSpace(currentPassword) || string.IsNullOrWhiteSpace(newPassword))
    {
        return Results.BadRequest(new { message = "Mevcut ve yeni sifre zorunludur." });
    }

    if (!IsValidPassword(newPassword))
    {
        return Results.BadRequest(new { message = "Yeni sifre en az 4 karakter olmali." });
    }

    lock (user.SyncRoot)
    {
        if (!VerifyPassword(currentPassword, user.PasswordHash))
        {
            logger.LogWarning("Invalid current password attempt for TcNo {TcNo}", tcNo);
            return Results.BadRequest(new { message = "Mevcut sifre hatali." });
        }

        if (VerifyPassword(newPassword, user.PasswordHash))
        {
            return Results.BadRequest(new { message = "Yeni sifre mevcut sifre ile ayni olamaz." });
        }

        user.PasswordHash = HashPassword(newPassword);
        user.Transactions.Add(new Transaction
        {
            Note = "Sifre guncellendi",
            Amount = 0m,
            Date = DateTime.Now
        });

        AddAudit(user, "password-change", "Kullanici sifresini guncelledi.", "warning");
    }

    return Results.Ok(new
    {
        message = "Sifre guncellendi.",
        account = ToResponse(user)
    });
});

secureApi.MapGet("/audit", (ClaimsPrincipal principal) =>
{
    if (!TryGetAuthenticatedUser(principal, out var user, out _))
    {
        return Results.Unauthorized();
    }

    var audit = user.AuditLogs
        .OrderByDescending(item => item.Date)
        .Take(250)
        .Select(item => new
        {
            date = item.Date.ToString("yyyy-MM-dd HH:mm:ss"),
            action = item.Action,
            detail = item.Detail,
            severity = item.Severity
        });

    return Results.Ok(audit);
});

app.Run();

string NormalizeDigits(string? value)
{
    if (string.IsNullOrWhiteSpace(value))
    {
        return string.Empty;
    }

    return new string(value.Where(char.IsDigit).ToArray());
}

string NormalizeIban(string? value)
{
    if (string.IsNullOrWhiteSpace(value))
    {
        return string.Empty;
    }

    return value
        .Replace(" ", string.Empty, StringComparison.Ordinal)
        .ToUpperInvariant();
}

bool IsValidTcNo(string tcNo) => tcNoRegex.IsMatch(tcNo);

bool IsValidPhone(string phone) => phoneRegex.IsMatch(phone);

bool IsValidPassword(string password) => !string.IsNullOrWhiteSpace(password) && password.Length >= 4;

bool IsValidIban(string iban) => ibanRegex.IsMatch(iban);

string HashPassword(string password) => BCrypt.Net.BCrypt.HashPassword(password, workFactor: 12);

bool VerifyPassword(string plainPassword, string hash)
{
    if (string.IsNullOrWhiteSpace(hash))
    {
        return false;
    }

    try
    {
        return BCrypt.Net.BCrypt.Verify(plainPassword, hash);
    }
    catch
    {
        return false;
    }
}

bool TryGetAuthenticatedUser(ClaimsPrincipal principal, out BankUser user, out string tcNo)
{
    tcNo = NormalizeDigits(
        principal.FindFirstValue("tcNo")
        ?? principal.FindFirstValue(ClaimTypes.NameIdentifier)
        ?? string.Empty);

    if (!IsValidTcNo(tcNo) || !users.TryGetValue(tcNo, out user!))
    {
        user = null!;
        tcNo = string.Empty;
        return false;
    }

    return true;
}

void AddAudit(BankUser user, string action, string detail, string severity)
{
    user.AuditLogs.Add(new AuditLog
    {
        Action = action,
        Detail = detail,
        Severity = severity,
        Date = DateTime.Now
    });

    if (user.AuditLogs.Count > 500)
    {
        user.AuditLogs = user.AuditLogs
            .OrderByDescending(item => item.Date)
            .Take(500)
            .ToList();
    }
}

string CreateJwtToken(BankUser user)
{
    var claims = new List<Claim>
    {
        new(ClaimTypes.NameIdentifier, user.TcNo),
        new("tcNo", user.TcNo),
        new(ClaimTypes.Name, user.Username)
    };

    var credentials = new SigningCredentials(jwtSigningKey, SecurityAlgorithms.HmacSha256);

    var token = new JwtSecurityToken(
        issuer: JwtIssuer,
        audience: JwtAudience,
        claims: claims,
        notBefore: DateTime.UtcNow,
        expires: DateTime.UtcNow.AddHours(12),
        signingCredentials: credentials);

    return new JwtSecurityTokenHandler().WriteToken(token);
}

void ResetDailyTransferWindowIfNeeded(BankUser user, DateTime now)
{
    var today = DateOnly.FromDateTime(now);
    if (user.TransferUsageDate != today)
    {
        user.TransferUsageDate = today;
        user.TransferUsedToday = 0m;
    }
}

void ResetCardDailySpendingWindowIfNeeded(BankUser user, DateTime now)
{
    var today = DateOnly.FromDateTime(now);
    if (user.Card.DailySpentDate != today)
    {
        user.Card.DailySpentDate = today;
        user.Card.DailySpentToday = 0m;
    }
}

decimal CalculateTransferFee(decimal amount, DateTime now, bool isInternalTransfer)
{
    if (isInternalTransfer)
    {
        return 0m;
    }

    var isWeekend = now.DayOfWeek is DayOfWeek.Saturday or DayOfWeek.Sunday;
    var isBusinessHours = now.Hour >= 9 && now.Hour < 17;
    var rate = !isWeekend && isBusinessHours ? 0.0025m : 0.0045m;

    return decimal.Round(decimal.Max(1.75m, amount * rate), 2);
}

int CalculateCreditScore(BankUser user)
{
    var score = 500;

    score += (int)decimal.Min(220m, user.Balance / 400m);
    score += Math.Min(90, user.Transactions.Count * 2);

    var incoming = user.Transactions.Where(tx => tx.Amount > 0).Sum(tx => tx.Amount);
    var outgoing = user.Transactions.Where(tx => tx.Amount < 0).Sum(tx => Math.Abs(tx.Amount));

    if (incoming >= outgoing)
    {
        score += 40;
    }
    else
    {
        score -= 55;
    }

    var debtRatio = user.Card.Limit <= 0 ? 0m : user.Card.Debt / user.Card.Limit;

    if (debtRatio > 0.8m)
    {
        score -= 80;
    }
    else if (debtRatio < 0.35m)
    {
        score += 35;
    }

    return Math.Clamp(score, 300, 900);
}

void SeedDemoUser()
{
    var user = new BankUser
    {
        Username = "Demo Kullanici",
        TcNo = "11111111111",
        Phone = "5551112233",
        PasswordHash = HashPassword("demo123"),
        Balance = 68250m,
        Iban = "TR31 0006 7010 0000 0000 0000 01",
        Card = new CardInfo
        {
            CardNumber = "4582 9012 8834 2201",
            Expiry = "12/30",
            Cvv = "473",
            Limit = 60000m,
            UsedLimit = 18500m,
            Debt = 18500m,
            CashAdvanceLimit = 20000m,
            CashAdvanceUsed = 4200m,
            Alias = "Ana Kredi Karti",
            OnlinePaymentsEnabled = true,
            ContactlessEnabled = true,
            InternationalUsageEnabled = false,
            CashAdvanceEnabled = true,
            AutoDebtPaymentEnabled = false,
            NotifyOnTransactions = true,
            IsTemporarilyBlocked = false,
            DailySpendingLimit = 25000m,
            DailySpentToday = 3600m,
            DailySpentDate = DateOnly.FromDateTime(DateTime.Now),
            StatementDay = 15
        },
        VirtualCard = new VirtualCardInfo
        {
            CardNumber = "4582 0000 0000 4432",
            Expiry = "12/30",
            Cvv = "941",
            Limit = 7500m,
            Spent = 1320m,
            IsActive = true,
            UpdatedAt = DateTime.Now.AddDays(-2)
        },
        Settings = new UserSettings
        {
            Email = "demo@sombank.com",
            Address = "Istanbul / Kadikoy",
            NotificationsEnabled = true,
            ReminderEnabled = true,
            Language = "tr-TR"
        },
        DailyTransferLimit = 120000m,
        TransferUsageDate = DateOnly.FromDateTime(DateTime.Now),
        TransferUsedToday = 9500m
    };

    user.Investments.Add(new InvestmentPosition
    {
        Asset = "Altin",
        UnitPrice = 3450m,
        Quantity = 3.120000m,
        TotalAmount = 10764m,
        Date = DateTime.Now.AddDays(-14)
    });

    user.Investments.Add(new InvestmentPosition
    {
        Asset = "USD",
        UnitPrice = 36.90m,
        Quantity = 450m,
        TotalAmount = 16605m,
        Date = DateTime.Now.AddDays(-8)
    });

    user.Applications.Add(new LoanApplication
    {
        Id = Guid.NewGuid().ToString("N"),
        LoanType = "Ihtiyac Kredisi",
        Amount = 150000m,
        Months = 24,
        Status = "Onaylandi",
        Date = DateTime.Now.AddDays(-20)
    });

    user.Transactions.Add(new Transaction { Note = "Maas odemesi", Amount = 52000m, Date = DateTime.Now.AddDays(-15) });
    user.Transactions.Add(new Transaction { Note = "Kira odemesi", Amount = -18000m, Date = DateTime.Now.AddDays(-12) });
    user.Transactions.Add(new Transaction { Note = "Market alisverisi", Amount = -3400m, Date = DateTime.Now.AddDays(-9) });
    user.Transactions.Add(new Transaction { Note = "Yatirim alimi - USD", Amount = -16605m, Date = DateTime.Now.AddDays(-8) });
    user.Transactions.Add(new Transaction { Note = "Elektrik faturasi", Amount = -1250m, Date = DateTime.Now.AddDays(-4) });
    user.Transactions.Add(new Transaction { Note = "Arkadastan gelen odeme", Amount = 3500m, Date = DateTime.Now.AddDays(-1) });

    user.BillHistory.Add(new BillPaymentHistory
    {
        Institution = "Elektrik",
        SubscriberNo = "44556677",
        Amount = 1250m,
        Note = "Elektrik faturasi",
        Date = DateTime.Now.AddDays(-4)
    });

    user.BillHistory.Add(new BillPaymentHistory
    {
        Institution = "Internet",
        SubscriberNo = "99887766",
        Amount = 680m,
        Note = "Internet faturasi",
        Date = DateTime.Now.AddDays(-2)
    });

    user.BillHistory.Add(new BillPaymentHistory
    {
        Institution = "Su",
        SubscriberNo = "22334455",
        Amount = 450m,
        Note = "Su faturasi",
        Date = DateTime.Now.AddDays(-1)
    });

    AddAudit(user, "seed", "Demo veri yuklemesi yapildi.", "information");

    users.TryAdd(user.TcNo, user);
}

UserSettings BuildDefaultSettings()
{
    return new UserSettings
    {
        Email = string.Empty,
        Address = string.Empty,
        NotificationsEnabled = true,
        ReminderEnabled = true,
        Language = "tr-TR"
    };
}

CardInfo BuildCard()
{
    var rnd = Random.Shared;

    string number = $"4582 {rnd.Next(1000, 9999)} {rnd.Next(1000, 9999)} {rnd.Next(1000, 9999)}";
    int month = rnd.Next(1, 13);
    int year = DateTime.Now.Year + rnd.Next(2, 6);

    decimal limit = rnd.Next(10000, 90000);
    decimal used = rnd.Next(0, (int)limit);
    decimal cashAdvanceLimit = decimal.Round(limit * 0.3m, 2);

    return new CardInfo
    {
        CardNumber = number,
        Expiry = $"{month:00}/{year % 100:00}",
        Cvv = rnd.Next(100, 1000).ToString(CultureInfo.InvariantCulture),
        Limit = limit,
        UsedLimit = used,
        Debt = used,
        CashAdvanceLimit = cashAdvanceLimit,
        CashAdvanceUsed = 0m,
        Alias = "SOMbank Kartim",
        OnlinePaymentsEnabled = true,
        ContactlessEnabled = true,
        InternationalUsageEnabled = false,
        CashAdvanceEnabled = true,
        AutoDebtPaymentEnabled = false,
        NotifyOnTransactions = true,
        IsTemporarilyBlocked = false,
        DailySpendingLimit = decimal.Min(limit, 20000m),
        DailySpentToday = 0m,
        DailySpentDate = DateOnly.FromDateTime(DateTime.Now),
        StatementDay = rnd.Next(1, 29)
    };
}

VirtualCardInfo BuildVirtualCard()
{
    var rnd = Random.Shared;

    return new VirtualCardInfo
    {
        CardNumber = $"4582 0000 {rnd.Next(1000, 9999)} {rnd.Next(1000, 9999)}",
        Expiry = $"{rnd.Next(1, 13):00}/{DateTime.Now.AddYears(3).Year % 100:00}",
        Cvv = rnd.Next(100, 1000).ToString(CultureInfo.InvariantCulture),
        Limit = 5000m,
        Spent = 0m,
        IsActive = true,
        UpdatedAt = DateTime.Now
    };
}

string BuildIban()
{
    return $"TR{Random.Shared.Next(10, 99)} {Random.Shared.Next(1000, 9999)} {Random.Shared.Next(1000, 9999)} {Random.Shared.Next(1000, 9999)} {Random.Shared.Next(1000, 9999)} {Random.Shared.Next(1000, 9999)}";
}

object ToResponse(BankUser user)
{
    var creditScore = CalculateCreditScore(user);
    var availableLimit = decimal.Max(0m, user.Card.Limit - user.Card.UsedLimit);
    var remainingDailySpending = decimal.Max(0m, user.Card.DailySpendingLimit - user.Card.DailySpentToday);
    var remainingCashAdvance = decimal.Max(0m, user.Card.CashAdvanceLimit - user.Card.CashAdvanceUsed);
    var remainingTransferLimit = decimal.Max(0m, user.DailyTransferLimit - user.TransferUsedToday);

    return new
    {
        username = user.Username,
        tcNo = user.TcNo,
        phone = user.Phone,
        balance = user.Balance,
        iban = user.Iban,
        creditScore,
        dailyLimits = new
        {
            transferLimit = user.DailyTransferLimit,
            transferUsedToday = user.TransferUsedToday,
            transferRemainingToday = remainingTransferLimit
        },
        settings = new
        {
            email = user.Settings.Email,
            address = user.Settings.Address,
            notificationsEnabled = user.Settings.NotificationsEnabled,
            reminderEnabled = user.Settings.ReminderEnabled,
            language = user.Settings.Language
        },
        transactions = user.Transactions
            .OrderByDescending(t => t.Date)
            .Select(t => new
            {
                note = t.Note,
                amount = t.Amount,
                date = t.Date.ToString("yyyy-MM-dd HH:mm:ss")
            }),
        billHistory = user.BillHistory
            .OrderByDescending(b => b.Date)
            .Select(b => new
            {
                institution = b.Institution,
                subscriberNo = b.SubscriberNo,
                amount = b.Amount,
                note = b.Note,
                date = b.Date.ToString("yyyy-MM-dd HH:mm:ss")
            }),
        investments = user.Investments
            .OrderByDescending(i => i.Date)
            .Select(i => new
            {
                asset = i.Asset,
                unitPrice = i.UnitPrice,
                quantity = i.Quantity,
                totalAmount = i.TotalAmount,
                date = i.Date.ToString("yyyy-MM-dd HH:mm:ss")
            }),
        card = new
        {
            cardNumber = user.Card.CardNumber,
            expiry = user.Card.Expiry,
            cvv = user.Card.Cvv,
            alias = user.Card.Alias,
            limit = user.Card.Limit,
            usedLimit = user.Card.UsedLimit,
            debt = user.Card.Debt,
            cashAdvanceLimit = user.Card.CashAdvanceLimit,
            cashAdvanceUsed = user.Card.CashAdvanceUsed,
            cashAdvanceRemaining = remainingCashAdvance,
            onlinePaymentsEnabled = user.Card.OnlinePaymentsEnabled,
            contactlessEnabled = user.Card.ContactlessEnabled,
            internationalUsageEnabled = user.Card.InternationalUsageEnabled,
            cashAdvanceEnabled = user.Card.CashAdvanceEnabled,
            autoDebtPaymentEnabled = user.Card.AutoDebtPaymentEnabled,
            notifyOnTransactions = user.Card.NotifyOnTransactions,
            isTemporarilyBlocked = user.Card.IsTemporarilyBlocked,
            dailySpendingLimit = user.Card.DailySpendingLimit,
            dailySpentToday = user.Card.DailySpentToday,
            dailySpendingRemaining = remainingDailySpending,
            statementDay = user.Card.StatementDay,
            availableLimit
        },
        virtualCard = user.VirtualCard is null ? null : new
        {
            cardNumber = user.VirtualCard.CardNumber,
            expiry = user.VirtualCard.Expiry,
            cvv = user.VirtualCard.Cvv,
            limit = user.VirtualCard.Limit,
            spent = user.VirtualCard.Spent,
            available = decimal.Max(0m, user.VirtualCard.Limit - user.VirtualCard.Spent),
            isActive = user.VirtualCard.IsActive,
            updatedAt = user.VirtualCard.UpdatedAt.ToString("yyyy-MM-dd HH:mm:ss")
        },
        applications = user.Applications
            .OrderByDescending(a => a.Date)
            .Select(a => new
            {
                id = a.Id,
                loanType = a.LoanType,
                amount = a.Amount,
                months = a.Months,
                status = a.Status,
                date = a.Date.ToString("yyyy-MM-dd HH:mm:ss")
            }),
        auditLogs = user.AuditLogs
            .OrderByDescending(a => a.Date)
            .Take(25)
            .Select(a => new
            {
                action = a.Action,
                detail = a.Detail,
                severity = a.Severity,
                date = a.Date.ToString("yyyy-MM-dd HH:mm:ss")
            })
    };
}

record RegisterRequest(string? TcNo, string? Phone, string Password, string? Username = null);
record LoginRequest(string? TcNo, string Password);
record TransferRequest(string ToIban, decimal Amount, string? Note);
record BillPaymentRequest(string Institution, string SubscriberNo, decimal Amount, string? Note);
record InvestmentRequest(string Asset, decimal UnitPrice, decimal Amount);
record CardLimitIncreaseRequest(decimal Amount);
record CardDebtPaymentRequest(decimal Amount);
record CardCashAdvanceRequest(decimal Amount);
record UpdateCardSettingsRequest(string? Alias, bool? OnlinePaymentsEnabled, bool? ContactlessEnabled, bool? InternationalUsageEnabled, bool? CashAdvanceEnabled, bool? IsTemporarilyBlocked, bool? AutoDebtPaymentEnabled, bool? NotifyOnTransactions, decimal? DailySpendingLimit, int? StatementDay);
record VirtualCardCreateRequest(decimal Limit);
record VirtualCardSpendRequest(decimal Amount);
record LoanApplicationRequest(string LoanType, decimal Amount, int Months);
record UpdateSettingsRequest(string? Username, string? Phone, string? Email, string? Address, bool NotificationsEnabled, bool ReminderEnabled, string? Language, decimal? DailyTransferLimit = null);
record ChangePasswordRequest(string CurrentPassword, string NewPassword);

class BankUser
{
    public string Username { get; set; } = string.Empty;
    public string TcNo { get; set; } = string.Empty;
    public string Phone { get; set; } = string.Empty;
    public string PasswordHash { get; set; } = string.Empty;
    public decimal Balance { get; set; }
    public string Iban { get; set; } = string.Empty;
    public decimal DailyTransferLimit { get; set; } = 120000m;
    public DateOnly TransferUsageDate { get; set; } = DateOnly.FromDateTime(DateTime.Now);
    public decimal TransferUsedToday { get; set; }
    public List<Transaction> Transactions { get; set; } = new();
    public List<BillPaymentHistory> BillHistory { get; set; } = new();
    public List<InvestmentPosition> Investments { get; set; } = new();
    public CardInfo Card { get; set; } = new();
    public VirtualCardInfo? VirtualCard { get; set; }
    public List<LoanApplication> Applications { get; set; } = new();
    public UserSettings Settings { get; set; } = new();
    public List<AuditLog> AuditLogs { get; set; } = new();
    public object SyncRoot { get; } = new();
}

class Transaction
{
    public string Note { get; set; } = string.Empty;
    public decimal Amount { get; set; }
    public DateTime Date { get; set; }
}

class InvestmentPosition
{
    public string Asset { get; set; } = string.Empty;
    public decimal UnitPrice { get; set; }
    public decimal Quantity { get; set; }
    public decimal TotalAmount { get; set; }
    public DateTime Date { get; set; }
}

class BillPaymentHistory
{
    public string Institution { get; set; } = string.Empty;
    public string SubscriberNo { get; set; } = string.Empty;
    public decimal Amount { get; set; }
    public string Note { get; set; } = string.Empty;
    public DateTime Date { get; set; }
}

class UserSettings
{
    public string Email { get; set; } = string.Empty;
    public string Address { get; set; } = string.Empty;
    public bool NotificationsEnabled { get; set; }
    public bool ReminderEnabled { get; set; }
    public string Language { get; set; } = "tr-TR";
}

class CardInfo
{
    public string CardNumber { get; set; } = string.Empty;
    public string Expiry { get; set; } = string.Empty;
    public string Cvv { get; set; } = string.Empty;
    public string Alias { get; set; } = "SOMbank Kartim";
    public decimal Limit { get; set; }
    public decimal UsedLimit { get; set; }
    public decimal Debt { get; set; }
    public decimal CashAdvanceLimit { get; set; }
    public decimal CashAdvanceUsed { get; set; }
    public bool OnlinePaymentsEnabled { get; set; } = true;
    public bool ContactlessEnabled { get; set; } = true;
    public bool InternationalUsageEnabled { get; set; }
    public bool CashAdvanceEnabled { get; set; } = true;
    public bool AutoDebtPaymentEnabled { get; set; }
    public bool NotifyOnTransactions { get; set; } = true;
    public bool IsTemporarilyBlocked { get; set; }
    public decimal DailySpendingLimit { get; set; } = 20000m;
    public decimal DailySpentToday { get; set; }
    public DateOnly DailySpentDate { get; set; } = DateOnly.FromDateTime(DateTime.Now);
    public int StatementDay { get; set; } = 15;
}

class VirtualCardInfo
{
    public string CardNumber { get; set; } = string.Empty;
    public string Expiry { get; set; } = string.Empty;
    public string Cvv { get; set; } = string.Empty;
    public decimal Limit { get; set; }
    public decimal Spent { get; set; }
    public bool IsActive { get; set; }
    public DateTime UpdatedAt { get; set; }
}

class LoanApplication
{
    public string Id { get; set; } = string.Empty;
    public string LoanType { get; set; } = string.Empty;
    public decimal Amount { get; set; }
    public int Months { get; set; }
    public string Status { get; set; } = string.Empty;
    public DateTime Date { get; set; }
}

class AuditLog
{
    public string Action { get; set; } = string.Empty;
    public string Detail { get; set; } = string.Empty;
    public string Severity { get; set; } = "information";
    public DateTime Date { get; set; }
}

class MarketState
{
    public object SyncRoot { get; } = new();
    public decimal UsdTry { get; set; } = 36.90m;
    public decimal EurTry { get; set; } = 39.80m;
    public decimal GoldTry { get; set; } = 3450m;
    public DateTime UpdatedAt { get; set; } = DateTime.Now;
}

class MarketAndInterestWorker(
    ConcurrentDictionary<string, BankUser> users,
    MarketState marketState,
    ILogger<MarketAndInterestWorker> logger) : BackgroundService
{
    private DateOnly _lastInterestDate = DateOnly.FromDateTime(DateTime.Now.AddDays(-1));

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        logger.LogInformation("MarketAndInterestWorker started.");

        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                UpdateMarketRates();
                ApplyDailyInterestIfNeeded();
            }
            catch (Exception ex)
            {
                logger.LogCritical(ex, "Background worker failed while running market/interest cycle.");
            }

            try
            {
                await Task.Delay(TimeSpan.FromSeconds(30), stoppingToken);
            }
            catch (OperationCanceledException)
            {
                break;
            }
        }
    }

    private void UpdateMarketRates()
    {
        lock (marketState.SyncRoot)
        {
            marketState.UsdTry = MoveRate(marketState.UsdTry);
            marketState.EurTry = MoveRate(marketState.EurTry);
            marketState.GoldTry = MoveRate(marketState.GoldTry);
            marketState.UpdatedAt = DateTime.Now;
        }
    }

    private void ApplyDailyInterestIfNeeded()
    {
        var today = DateOnly.FromDateTime(DateTime.Now);
        if (today == _lastInterestDate)
        {
            return;
        }

        _lastInterestDate = today;

        foreach (var entry in users)
        {
            var user = entry.Value;

            lock (user.SyncRoot)
            {
                if (user.Balance <= 0)
                {
                    continue;
                }

                var dailyRate = 0.00035m;
                var interest = decimal.Round(user.Balance * dailyRate, 2);

                if (interest <= 0)
                {
                    continue;
                }

                user.Balance += interest;
                user.Transactions.Add(new Transaction
                {
                    Note = "Gunluk faiz getirisi",
                    Amount = interest,
                    Date = DateTime.Now
                });

                user.AuditLogs.Add(new AuditLog
                {
                    Action = "interest-credit",
                    Detail = $"Gunluk faiz olarak {interest.ToString("F2", CultureInfo.InvariantCulture)} TL tanimlandi.",
                    Severity = "information",
                    Date = DateTime.Now
                });
            }
        }

        logger.LogInformation("Daily interest distribution completed for {Count} users.", users.Count);
    }

    private static decimal MoveRate(decimal current)
    {
        var deltaRatio = (decimal)(Random.Shared.NextDouble() * 0.04d - 0.02d);
        var next = current + current * deltaRatio;

        if (next <= 0)
        {
            return current;
        }

        return decimal.Round(next, 2);
    }
}
