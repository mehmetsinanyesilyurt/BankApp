using Microsoft.EntityFrameworkCore;
using BankApp.Models;

namespace BankApp.Data;

public class BankDbContext : DbContext
{
    public BankDbContext(DbContextOptions<BankDbContext> options) : base(options) {}

    public DbSet<User> Users { get; set; }
}
