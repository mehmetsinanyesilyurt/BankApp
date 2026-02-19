using System;
using System.ComponentModel.DataAnnotations;

namespace BankApp.Models
{
    public class User 
    {
        [Key]
        public int Id { get; set; }

        [Required]
        public string Username { get; set; }

        [Required]
        public string Password { get; set; } 

        public decimal Balance { get; set; } = 1500.00m;

        public string Iban { get; set; } = "TR" + new Random().Next(1000, 9999) + "..." + new Random().Next(10, 99);
    }
}

