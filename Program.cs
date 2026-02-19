var builder = WebApplication.CreateBuilder(args);
builder.Services.AddCors();
var app = builder.Build();

app.UseCors(x => x.AllowAnyOrigin().AllowAnyHeader().AllowAnyMethod());

// fake data
decimal balance = 12500;

app.MapGet("/", () => "BANK API RUNNING");

// bakiye
app.MapGet("/balance", () => new { balance });

// para gönder
app.MapPost("/transfer", (TransferDto dto) =>
{
    if (dto.Amount <= 0) return Results.BadRequest("Hatalı tutar");
    balance -= dto.Amount;
    return Results.Ok(new { message = "Transfer başarılı", balance });
});

app.Run();

record TransferDto(string ToIban, decimal Amount);
    