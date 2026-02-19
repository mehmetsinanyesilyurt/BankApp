using Microsoft.AspNetCore.Mvc;
using BankApp.Data;
using BankApp.Models;
using Microsoft.AspNetCore.Http;
using System.Linq;

namespace BankApp.Controllers
{
    public class AccountController : Controller
    {
        private readonly ApplicationDbContext _context;

        public AccountController(ApplicationDbContext context)
        {
            _context = context;
        }

        // Kayıt Sayfası
        [HttpGet]
        public IActionResult Register() => View();

        [HttpPost]
        public IActionResult Register(User user)
        {
            if (ModelState.IsValid)
            {
                _context.Users.Add(user);
                _context.SaveChanges();
                return RedirectToAction("Login");
            }
            return View(user);
        }

        // Giriş Sayfası
        [HttpGet]
        public IActionResult Login() => View();

        [HttpPost]
        public IActionResult Login(string username, string password)
        {
            var user = _context.Users.FirstOrDefault(u => u.Username == username && u.Password == password);
            if (user != null)
            {
                // HTML tarafında @Context.Session.GetString ile okuyacağımız veriler
                HttpContext.Session.SetString("UserName", user.Username);
                HttpContext.Session.SetString("UserBalance", user.Balance.ToString("N2"));
                HttpContext.Session.SetString("UserIban", user.Iban);
                
                return RedirectToAction("Index", "Home");
            }
            ViewBag.Error = "Kullanıcı adı veya şifre hatalı!";
            return View();
        }
    }
}