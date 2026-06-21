const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, "public");
const DATA_DIR = path.join(ROOT, "data");
const CUSTOMERS_FILE = path.join(DATA_DIR, "customers.json");
const EMPLOYEES_FILE = path.join(DATA_DIR, "employees.json");
const TRANSACTIONS_FILE = path.join(DATA_DIR, "transactions.json");
const TOKEN_SECRET = process.env.TOKEN_SECRET || "automated-banking-demo-secret";

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml"
};

function ensureDataFiles() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  for (const file of [CUSTOMERS_FILE, EMPLOYEES_FILE, TRANSACTIONS_FILE]) {
    if (!fs.existsSync(file)) fs.writeFileSync(file, "[]\n");
  }

  const employees = readJson(EMPLOYEES_FILE);
  if (employees.length === 0) {
    writeJson(EMPLOYEES_FILE, [
      {
        id: createId("emp"),
        fullName: "Branch Manager",
        email: "manager@bank.local",
        role: "manager",
        passwordHash: hashPassword("Manager@123"),
        status: "active",
        createdAt: now()
      },
      {
        id: createId("emp"),
        fullName: "Bank Staff",
        email: "staff@bank.local",
        role: "staff",
        passwordHash: hashPassword("Staff@123"),
        status: "active",
        createdAt: now()
      }
    ]);
  }
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8") || "[]");
}

function writeJson(file, value) {
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

function now() {
  return new Date().toISOString();
}

function createId(prefix) {
  return `${prefix}_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.pbkdf2Sync(password, salt, 100000, 64, "sha512").toString("hex");
  return `${salt}:${hash}`;
}

function verifyPassword(password, storedHash) {
  const [salt, hash] = storedHash.split(":");
  const attempted = crypto.pbkdf2Sync(password, salt, 100000, 64, "sha512").toString("hex");
  return crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(attempted));
}

function signToken(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = crypto.createHmac("sha256", TOKEN_SECRET).update(body).digest("base64url");
  return `${body}.${signature}`;
}

function verifyToken(token) {
  if (!token || !token.includes(".")) return null;
  const [body, signature] = token.split(".");
  const expected = crypto.createHmac("sha256", TOKEN_SECRET).update(body).digest("base64url");
  if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;
  const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  if (payload.exp < Date.now()) return null;
  return payload;
}

function publicCustomer(customer) {
  const { passwordHash, ...safeCustomer } = customer;
  return safeCustomer;
}

function publicEmployee(employee) {
  const { passwordHash, ...safeEmployee } = employee;
  return safeEmployee;
}

function sendJson(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", chunk => {
      body += chunk;
      if (body.length > 1_000_000) reject(new Error("Request body too large"));
    });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error("Invalid JSON"));
      }
    });
  });
}

function getAuth(req) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  return verifyToken(token);
}

function requireRole(req, res, roles) {
  const auth = getAuth(req);
  if (!auth || !roles.includes(auth.role)) {
    sendJson(res, 401, { message: "Unauthorized access" });
    return null;
  }
  return auth;
}

function validateAmount(amount) {
  const value = Number(amount);
  return Number.isFinite(value) && value > 0 ? Number(value.toFixed(2)) : null;
}

function createAccountNumber(customers) {
  let accountNumber;
  do {
    accountNumber = String(Math.floor(1000000000 + Math.random() * 9000000000));
  } while (customers.some(customer => customer.accountNumber === accountNumber));
  return accountNumber;
}

function addTransaction({ customerId, accountNumber, type, amount, description, balanceAfter, relatedAccount, performedBy }) {
  const transactions = readJson(TRANSACTIONS_FILE);
  const transaction = {
    id: createId("txn"),
    customerId,
    accountNumber,
    type,
    amount,
    description,
    relatedAccount: relatedAccount || "",
    balanceAfter,
    status: "success",
    performedBy: performedBy || "customer",
    createdAt: now()
  };
  transactions.unshift(transaction);
  writeJson(TRANSACTIONS_FILE, transactions);
  return transaction;
}

async function handleApi(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const route = `${req.method} ${url.pathname}`;

  try {
    if (route === "POST /api/auth/signup") {
      const body = await readBody(req);
      const required = ["fullName", "email", "phone", "address", "dateOfBirth", "accountType", "password"];
      if (required.some(field => !String(body[field] || "").trim())) {
        return sendJson(res, 400, { message: "Please fill all required fields" });
      }
      if (String(body.password).length < 6) {
        return sendJson(res, 400, { message: "Password must contain at least 6 characters" });
      }

      const customers = readJson(CUSTOMERS_FILE);
      const email = String(body.email).trim().toLowerCase();
      if (customers.some(customer => customer.email === email)) {
        return sendJson(res, 409, { message: "Email is already registered" });
      }

      const customer = {
        id: createId("cus"),
        accountNumber: createAccountNumber(customers),
        fullName: String(body.fullName).trim(),
        email,
        phone: String(body.phone).trim(),
        address: String(body.address).trim(),
        dateOfBirth: String(body.dateOfBirth).trim(),
        accountType: String(body.accountType).trim(),
        passwordHash: hashPassword(String(body.password)),
        balance: 1000,
        status: "active",
        role: "customer",
        createdAt: now()
      };

      customers.push(customer);
      writeJson(CUSTOMERS_FILE, customers);
      addTransaction({
        customerId: customer.id,
        accountNumber: customer.accountNumber,
        type: "opening-balance",
        amount: 1000,
        description: "Account opening balance",
        balanceAfter: customer.balance
      });

      return sendJson(res, 201, { message: "Account created successfully", customer: publicCustomer(customer) });
    }

    if (route === "POST /api/auth/login") {
      const body = await readBody(req);
      const email = String(body.email || "").trim().toLowerCase();
      const password = String(body.password || "");
      const customers = readJson(CUSTOMERS_FILE);
      const customer = customers.find(item => item.email === email);
      if (!customer || !verifyPassword(password, customer.passwordHash)) {
        return sendJson(res, 401, { message: "Invalid email or password" });
      }
      if (customer.status !== "active") {
        return sendJson(res, 403, { message: "Your account is blocked. Please contact the bank." });
      }
      const token = signToken({ id: customer.id, role: "customer", exp: Date.now() + 24 * 60 * 60 * 1000 });
      return sendJson(res, 200, { token, user: publicCustomer(customer) });
    }

    if (route === "POST /api/employee/login") {
      const body = await readBody(req);
      const email = String(body.email || "").trim().toLowerCase();
      const password = String(body.password || "");
      const employees = readJson(EMPLOYEES_FILE);
      const employee = employees.find(item => item.email === email);
      if (!employee || !verifyPassword(password, employee.passwordHash)) {
        return sendJson(res, 401, { message: "Invalid employee credentials" });
      }
      const token = signToken({ id: employee.id, role: employee.role, exp: Date.now() + 12 * 60 * 60 * 1000 });
      return sendJson(res, 200, { token, user: publicEmployee(employee) });
    }

    if (route === "GET /api/customer/me") {
      const auth = requireRole(req, res, ["customer"]);
      if (!auth) return;
      const customer = readJson(CUSTOMERS_FILE).find(item => item.id === auth.id);
      return customer ? sendJson(res, 200, { customer: publicCustomer(customer) }) : sendJson(res, 404, { message: "Customer not found" });
    }

    if (route === "PUT /api/customer/me") {
      const auth = requireRole(req, res, ["customer"]);
      if (!auth) return;
      const body = await readBody(req);
      const customers = readJson(CUSTOMERS_FILE);
      const index = customers.findIndex(item => item.id === auth.id);
      if (index === -1) return sendJson(res, 404, { message: "Customer not found" });
      for (const field of ["fullName", "phone", "address"]) {
        if (body[field]) customers[index][field] = String(body[field]).trim();
      }
      writeJson(CUSTOMERS_FILE, customers);
      return sendJson(res, 200, { message: "Profile updated", customer: publicCustomer(customers[index]) });
    }

    if (route === "POST /api/banking/deposit") {
      const auth = requireRole(req, res, ["customer", "staff"]);
      if (!auth) return;
      const body = await readBody(req);
      const amount = validateAmount(body.amount);
      if (!amount) return sendJson(res, 400, { message: "Enter a valid amount" });

      const customers = readJson(CUSTOMERS_FILE);
      const index = auth.role === "customer"
        ? customers.findIndex(item => item.id === auth.id)
        : customers.findIndex(item => item.accountNumber === String(body.accountNumber || "").trim());
      if (index === -1) return sendJson(res, 404, { message: "Account not found" });
      if (customers[index].status !== "active") return sendJson(res, 403, { message: "Account is blocked" });

      customers[index].balance = Number((customers[index].balance + amount).toFixed(2));
      writeJson(CUSTOMERS_FILE, customers);
      const transaction = addTransaction({
        customerId: customers[index].id,
        accountNumber: customers[index].accountNumber,
        type: "deposit",
        amount,
        description: "Money deposited",
        balanceAfter: customers[index].balance,
        performedBy: auth.role
      });
      return sendJson(res, 200, { message: "Amount deposited successfully", balance: customers[index].balance, transaction });
    }

    if (route === "POST /api/banking/withdraw") {
      const auth = requireRole(req, res, ["customer", "staff"]);
      if (!auth) return;
      const body = await readBody(req);
      const amount = validateAmount(body.amount);
      if (!amount) return sendJson(res, 400, { message: "Enter a valid amount" });

      const customers = readJson(CUSTOMERS_FILE);
      const index = auth.role === "customer"
        ? customers.findIndex(item => item.id === auth.id)
        : customers.findIndex(item => item.accountNumber === String(body.accountNumber || "").trim());
      if (index === -1) return sendJson(res, 404, { message: "Account not found" });
      if (customers[index].balance < amount) return sendJson(res, 400, { message: "Insufficient balance" });

      customers[index].balance = Number((customers[index].balance - amount).toFixed(2));
      writeJson(CUSTOMERS_FILE, customers);
      const transaction = addTransaction({
        customerId: customers[index].id,
        accountNumber: customers[index].accountNumber,
        type: "withdrawal",
        amount,
        description: "Money withdrawn",
        balanceAfter: customers[index].balance,
        performedBy: auth.role
      });
      return sendJson(res, 200, { message: "Amount withdrawn successfully", balance: customers[index].balance, transaction });
    }

    if (route === "POST /api/banking/transfer") {
      const auth = requireRole(req, res, ["customer"]);
      if (!auth) return;
      const body = await readBody(req);
      const amount = validateAmount(body.amount);
      const receiverAccount = String(body.receiverAccount || "").trim();
      if (!amount || !receiverAccount) return sendJson(res, 400, { message: "Enter receiver account and valid amount" });

      const customers = readJson(CUSTOMERS_FILE);
      const senderIndex = customers.findIndex(item => item.id === auth.id);
      const receiverIndex = customers.findIndex(item => item.accountNumber === receiverAccount);
      if (receiverIndex === -1) return sendJson(res, 404, { message: "Receiver account not found" });
      if (senderIndex === receiverIndex) return sendJson(res, 400, { message: "Cannot transfer to the same account" });
      if (customers[senderIndex].balance < amount) return sendJson(res, 400, { message: "Insufficient balance" });

      customers[senderIndex].balance = Number((customers[senderIndex].balance - amount).toFixed(2));
      customers[receiverIndex].balance = Number((customers[receiverIndex].balance + amount).toFixed(2));
      writeJson(CUSTOMERS_FILE, customers);
      const debit = addTransaction({
        customerId: customers[senderIndex].id,
        accountNumber: customers[senderIndex].accountNumber,
        type: "transfer-debit",
        amount,
        description: `Transfer to ${customers[receiverIndex].accountNumber}`,
        relatedAccount: customers[receiverIndex].accountNumber,
        balanceAfter: customers[senderIndex].balance
      });
      addTransaction({
        customerId: customers[receiverIndex].id,
        accountNumber: customers[receiverIndex].accountNumber,
        type: "transfer-credit",
        amount,
        description: `Transfer from ${customers[senderIndex].accountNumber}`,
        relatedAccount: customers[senderIndex].accountNumber,
        balanceAfter: customers[receiverIndex].balance
      });
      return sendJson(res, 200, { message: "Transfer completed successfully", balance: customers[senderIndex].balance, transaction: debit });
    }

    if (route === "GET /api/banking/transactions") {
      const auth = requireRole(req, res, ["customer"]);
      if (!auth) return;
      const transactions = readJson(TRANSACTIONS_FILE).filter(item => item.customerId === auth.id);
      return sendJson(res, 200, { transactions });
    }

    if (route === "GET /api/staff/customers") {
      const auth = requireRole(req, res, ["staff", "manager"]);
      if (!auth) return;
      const search = String(url.searchParams.get("search") || "").toLowerCase();
      const customers = readJson(CUSTOMERS_FILE)
        .filter(customer => !search || customer.fullName.toLowerCase().includes(search) || customer.email.includes(search) || customer.accountNumber.includes(search))
        .map(publicCustomer);
      return sendJson(res, 200, { customers });
    }

    if (route === "GET /api/staff/transactions") {
      const auth = requireRole(req, res, ["staff", "manager"]);
      if (!auth) return;
      const accountNumber = String(url.searchParams.get("accountNumber") || "").trim();
      const transactions = readJson(TRANSACTIONS_FILE)
        .filter(transaction => !accountNumber || transaction.accountNumber === accountNumber)
        .slice(0, 200);
      return sendJson(res, 200, { transactions });
    }

    if (route === "PATCH /api/manager/customer-status") {
      const auth = requireRole(req, res, ["manager"]);
      if (!auth) return;
      const body = await readBody(req);
      const accountNumber = String(body.accountNumber || "").trim();
      const status = String(body.status || "").trim();
      if (!["active", "blocked"].includes(status)) return sendJson(res, 400, { message: "Invalid status" });
      const customers = readJson(CUSTOMERS_FILE);
      const index = customers.findIndex(item => item.accountNumber === accountNumber);
      if (index === -1) return sendJson(res, 404, { message: "Customer not found" });
      customers[index].status = status;
      writeJson(CUSTOMERS_FILE, customers);
      return sendJson(res, 200, { message: `Customer account ${status}`, customer: publicCustomer(customers[index]) });
    }

    if (route === "GET /api/manager/summary") {
      const auth = requireRole(req, res, ["manager"]);
      if (!auth) return;
      const customers = readJson(CUSTOMERS_FILE);
      const transactions = readJson(TRANSACTIONS_FILE);
      const totalBalance = customers.reduce((sum, customer) => sum + Number(customer.balance || 0), 0);
      return sendJson(res, 200, {
        summary: {
          customers: customers.length,
          activeCustomers: customers.filter(customer => customer.status === "active").length,
          blockedCustomers: customers.filter(customer => customer.status === "blocked").length,
          transactions: transactions.length,
          totalBalance: Number(totalBalance.toFixed(2))
        }
      });
    }

    return sendJson(res, 404, { message: "API route not found" });
  } catch (error) {
    return sendJson(res, 500, { message: error.message || "Server error" });
  }
}

function serveStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  let filePath = decodeURIComponent(url.pathname);
  if (filePath === "/") filePath = "/index.html";
  const safePath = path.normalize(filePath).replace(/^(\.\.[/\\])+/, "");
  const absolutePath = path.join(PUBLIC_DIR, safePath);

  if (!absolutePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end("Forbidden");
  }

  fs.readFile(absolutePath, (error, content) => {
    if (error) {
      res.writeHead(404, { "Content-Type": "text/html; charset=utf-8" });
      return res.end("<h1>404 - Page not found</h1>");
    }
    const ext = path.extname(absolutePath);
    res.writeHead(200, { "Content-Type": mimeTypes[ext] || "application/octet-stream" });
    res.end(content);
  });
}

ensureDataFiles();

http.createServer((req, res) => {
  if (req.url.startsWith("/api/")) return handleApi(req, res);
  return serveStatic(req, res);
}).listen(PORT, () => {
  console.log(`Automated Banking System running at http://localhost:${PORT}`);
});
