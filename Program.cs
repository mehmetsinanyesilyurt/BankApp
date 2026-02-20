using System.Collections.Concurrent; // ConcurrentDictionary için Namespace eklenmeli


var builder = WebApplication.CreateBuilder(args); 

builder.Services.AddCors(options =>
{
    options.AddPolicy("AllowAll", policy =>
    {
        policy.AllowAnyOrigin()
            .AllowAnyHeader()
            .AllowAnyMethod();
    });
});

var app = builder.Build();

app.UseCors("AllowAll");
app.UseDefaultFiles();
app.UseStaticFiles();

var users = new ConcurrentDictionary<string, BankUser>(StringComparer.OrdinalIgnoreCase);

SeedUser("demo", "demo123", 12500m, "TR31 0006 7010 0000 0000 0000 01");

app.MapPost("/api/auth/register", (RegisterRequest request) =>
{
    var username = request.Username?.Trim();
    var password = request.Password?.Trim();

    if (string.IsNullOrWhiteSpace(username) || string.IsNullOrWhiteSpace(password))
    {
        return Results.BadRequest(new { message = "Kullanici adi ve sifre zorunludur." });
    }

    if (users.ContainsKey(username))
    {
        return Results.BadRequest(new { message = "Bu kullanici adi zaten kayitli." });
    }

    var user = new BankUser
    {
        Username = username,
        Password = password,
        Balance = 1500m,
        Iban = BuildIban()
    };

    user.Transactions.Add(new Transaction
    {
        Note = "Hesap olusturma",
        Amount = 0m,
        Date = DateTime.Now
    });

    if (!users.TryAdd(username, user))
    {
        return Results.BadRequest(new { message = "Kayit olusturulamadi." });
    }

    return Results.Ok(ToResponse(user));
});

app.MapPost("/api/auth/login", (LoginRequest request) =>
{
    var username = request.Username?.Trim();

    if (string.IsNullOrWhiteSpace(username) || string.IsNullOrWhiteSpace(request.Password))
    {
        return Results.BadRequest(new { message = "Kullanici adi ve sifre zorunludur." });
    }

    if (!users.TryGetValue(username, out var user) || user.Password != request.Password)
    {
        return Results.BadRequest(new { message = "Kullanici adi veya sifre hatali." });
    }

    return Results.Ok(ToResponse(user));
});

app.MapGet("/api/account/{username}", (string username) =>
{
    var normalized = username.Trim();

    if (string.IsNullOrWhiteSpace(normalized) || !users.TryGetValue(normalized, out var user))
    {
        return Results.NotFound(new { message = "Kullanici bulunamadi." });
    }

    return Results.Ok(ToResponse(user));
});

app.MapPost("/api/account/transfer", (TransferRequest request) =>
{
    var username = request.Username?.Trim();
    var toIban = request.ToIban?.Trim();

    if (string.IsNullOrWhiteSpace(username) || !users.TryGetValue(username, out var user))
    {
        return Results.NotFound(new { message = "Kullanici bulunamadi." });
    }

    if (string.IsNullOrWhiteSpace(toIban) || toIban.Length < 10)
    {
        return Results.BadRequest(new { message = "Gecerli bir alici IBAN giriniz." });
    }

    if (request.Amount <= 0)
    {
        return Results.BadRequest(new { message = "Tutar sifirdan buyuk olmali." });
    }

    lock (user)
    {
        if (user.Balance < request.Amount)
        {
            return Results.BadRequest(new { message = "Yetersiz bakiye." });
        }

        user.Balance -= request.Amount;
        user.Transactions.Add(new Transaction
        {
            Note = string.IsNullOrWhiteSpace(request.Note) ? "Para transferi" : request.Note.Trim(),
            Amount = request.Amount,
            Date = DateTime.Now
        });
    }

    return Results.Ok(new
    {
        message = "Transfer basarili.",
        account = ToResponse(user)
    });
});

app.Run();

void SeedUser(string username, string password, decimal balance, string iban)
{
    var user = new BankUser
    {
        Username = username,
        Password = password,
        Balance = balance,
        Iban = iban
    };

    user.Transactions.Add(new Transaction
    {
        Note = "Hesap açılış bakiyesi",
        Amount = 0m,
        Date = DateTime.Now
    });

    users.TryAdd(username, user);
}

string BuildIban()
{
    return $"TR{Random.Shared.Next(10, 99)} {Random.Shared.Next(1000, 9999)} {Random.Shared.Next(1000, 9999)} {Random.Shared.Next(1000, 9999)} {Random.Shared.Next(1000, 9999)} {Random.Shared.Next(1000, 9999)}";
}

static object ToResponse(BankUser user)
{
    return new
    {
        username = user.Username,
        balance = user.Balance,
        iban = user.Iban,
        transactions = user.Transactions
            .OrderByDescending(x => x.Date)
            .Select(x => new
            {
                note = x.Note,
                amount = x.Amount,
                date = x.Date.ToString("yyyy-MM-dd HH:mm:ss")
            })
    };
}

record RegisterRequest(string Username, string Password);
record LoginRequest(string Username, string Password);
record TransferRequest(string Username, string ToIban, decimal Amount, string? Note);

class BankUser // Kullanıcı bilgilerini temsil eden sınıf
{
    public string Username { get; set; } = string.Empty;
    public string Password { get; set; } = string.Empty;
    public decimal Balance { get; set; }
    public string Iban { get; set; } = string.Empty;
    public List<Transaction> Transactions { get; set; } = new();
}

class Transaction // Kullanıcının yaptığı işlemleri temsil eden sınıf
{
    public string Note { get; set; } = string.Empty;
    public decimal Amount { get; set; }
    public DateTime Date { get; set; }
}
