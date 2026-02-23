using Microsoft.EntityFrameworkCore;
using BankApp.Models; 

namespace BankApp.Data
{
    public class ApplicationDbContext : DbContext
    {
        public ApplicationDbContext(DbContextOptions<ApplicationDbContext> options)
            : base(options)
        {
        }

        // Bu satır "User" modelini veritabanında "Users" tablosu yapar
        public DbSet<User> Users { get; set; }
    }
}