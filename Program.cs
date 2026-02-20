using System.Collections.Concurrent;

var builder = WebApplication.CreateBuilder(args);
builder.Services.AddCors();

var app = builder.Build();

app.UseCors(x => x.AllowAnyOrigin().AllowAnyHeader().AllowAnyMethod());
app.UseDefaultFiles();
app.UseStaticFiles();

var users = new ConcurrentDictionary<string, BankUser>(StringComparer.OrdinalIgnoreCase);

SeedUser("sinan", "123456", 842500.45m, "TR12 3456 7890 1234 5678 9012 34");
SeedUser("demo", "demo123", 12500m, "TR98 0000 1111 2222 3333 4444 55");

app.MapGet("/api/health", () => Results.Ok(new { status = "ok" }));

app.MapPost("/api/auth/register", (RegisterRequest request) =>
{
    if (string.IsNullOrWhiteSpace(request.Username) || string.IsNullOrWhiteSpace(request.Password))
    {
        return Results.BadRequest(new { message = "Kullanıcı adı ve şifre zorunludur." });
    }

    var normalizedUsername = request.Username.Trim();
    if (users.ContainsKey(normalizedUsername))
    {
        return Results.BadRequest(new { message = "Bu kullanıcı adı zaten kayıtlı." });
    }

    var user = new BankUser(
        normalizedUsername,
        request.Password,
        1500m,
        BuildIban());

    if (!users.TryAdd(normalizedUsername, user))
    {
        return Results.BadRequest(new { message = "Kayıt sırasında bir hata oluştu." });
    }

    return Results.Ok(ToResponse(user));
});

app.MapPost("/api/auth/login", (LoginRequest request) =>
{
    if (!users.TryGetValue(request.Username?.Trim() ?? string.Empty, out var user) || user.Password != request.Password)
    {
        return Results.BadRequest(new { message = "Kullanıcı adı veya şifre hatalı." });
    }

    return Results.Ok(ToResponse(user));
});

app.MapGet("/api/account/{username}", (string username) =>
{
    if (!users.TryGetValue(username.Trim(), out var user))
    {
        return Results.NotFound(new { message = "Kullanıcı bulunamadı." });
    }

    return Results.Ok(ToResponse(user));
});

app.MapPost("/api/account/transfer", (TransferRequest request) =>
{
    if (string.IsNullOrWhiteSpace(request.Username) || !users.TryGetValue(request.Username.Trim(), out var user))
    {
        return Results.NotFound(new { message = "Kullanıcı bulunamadı." });
    }

    if (string.IsNullOrWhiteSpace(request.ToIban) || request.ToIban.Trim().Length < 8)
    {
        return Results.BadRequest(new { message = "Geçerli bir alıcı IBAN giriniz." });
    }

    if (request.Amount <= 0)
    {
        return Results.BadRequest(new { message = "Tutar 0'dan büyük olmalıdır." });
    }

    lock (user)
    {
        if (request.Amount > user.Balance)
        {
            return Results.BadRequest(new { message = "Yetersiz bakiye." });
        }

        user.Balance -= request.Amount;
    }

    return Results.Ok(new
    {
        message = "Transfer başarılı.",
        account = ToResponse(user)
    });
});

app.Run();

void SeedUser(string username, string password, decimal balance, string iban)
{
    users.TryAdd(username, new BankUser(username, password, balance, iban));
}

string BuildIban()
{
    var random = Random.Shared.Next(1000, 9999);
    var randomSuffix = Random.Shared.Next(1000, 9999);
    return $"TR90 {random} 1000 2000 3000 4000 {randomSuffix}";
}

object ToResponse(BankUser user) => new
{
    username = user.Username,
    balance = user.Balance,
    iban = user.Iban
};

record RegisterRequest(string Username, string Password);
record LoginRequest(string Username, string Password);
record TransferRequest(string Username, string ToIban, decimal Amount, string? Note);

class BankUser
{
    public BankUser(string username, string password, decimal balance, string iban)
    {
        Username = username;
        Password = password;
        Balance = balance;
        Iban = iban;
    }

    public string Username { get; }
    public string Password { get; }
    public decimal Balance { get; set; }
    public string Iban { get; }
}
