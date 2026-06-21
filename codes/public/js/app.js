import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js";
import {
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signOut,
  onAuthStateChanged,
  getAuth
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js";
import {
  collection,
  doc,
  getDoc,
  getDocs,
  getFirestore,
  increment,
  limit,
  orderBy,
  query,
  runTransaction,
  serverTimestamp,
  setDoc,
  updateDoc,
  where
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

function showMessage(id, text, type = "error") {
  const element = document.getElementById(id);
  if (!element) return;
  element.textContent = text;
  element.className = `message ${type}`;
}

function money(value) {
  return Number(value || 0).toLocaleString("en-IN", { style: "currency", currency: "INR" });
}

function dateTime(value) {
  if (!value) return "-";
  const date = value.toDate ? value.toDate() : new Date(value);
  return date.toLocaleString("en-IN");
}

function createAccountNumber() {
  return String(Math.floor(1000000000 + Math.random() * 9000000000));
}

function formData(form) {
  return Object.fromEntries(new FormData(form).entries());
}

function requireFirebaseConfig() {
  if (firebaseConfig.apiKey.startsWith("PASTE_")) {
    throw new Error("Add your Firebase config in public/js/firebase-config.js first.");
  }
}

async function getCurrentProfile() {
  const user = auth.currentUser;
  if (!user) return null;

  const customerSnap = await getDoc(doc(db, "customers", user.uid));
  if (customerSnap.exists()) return { id: user.uid, ...customerSnap.data() };

  const employeeSnap = await getDoc(doc(db, "employees", user.uid));
  if (employeeSnap.exists()) return { id: user.uid, ...employeeSnap.data() };

  return null;
}

function requireRole(allowedRoles, loginPage) {
  return new Promise(resolve => {
    onAuthStateChanged(auth, async user => {
      if (!user) {
        window.location.href = loginPage;
        return;
      }

      const profile = await getCurrentProfile();
      if (!profile || !allowedRoles.includes(profile.role)) {
        await signOut(auth);
        window.location.href = loginPage;
        return;
      }

      resolve(profile);
    });
  });
}

async function logout() {
  await signOut(auth);
  window.location.href = "/";
}

function setupLogout() {
  const button = document.getElementById("logoutBtn");
  if (button) button.addEventListener("click", logout);
}

function bindSignup() {
  const form = document.getElementById("signupForm");
  if (!form) return;

  form.addEventListener("submit", async event => {
    event.preventDefault();
    try {
      requireFirebaseConfig();
      const body = formData(form);
      const credential = await createUserWithEmailAndPassword(auth, body.email, body.password);
      const accountNumber = createAccountNumber();
      const customer = {
        accountNumber,
        fullName: body.fullName.trim(),
        email: body.email.trim().toLowerCase(),
        phone: body.phone.trim(),
        address: body.address.trim(),
        dateOfBirth: body.dateOfBirth,
        accountType: body.accountType,
        balance: 1000,
        status: "active",
        role: "customer",
        createdAt: serverTimestamp()
      };

      await setDoc(doc(db, "customers", credential.user.uid), customer);
      await setDoc(doc(db, "accountDirectory", accountNumber), {
        customerId: credential.user.uid,
        accountNumber,
        fullName: customer.fullName,
        status: "active"
      });
      await addTransaction(credential.user.uid, {
        accountNumber,
        type: "opening-balance",
        amount: 1000,
        description: "Account opening balance",
        balanceAfter: 1000,
        performedBy: "customer"
      });

      await signOut(auth);
      showMessage("signupMessage", "Account created. You can login now.", "success");
      form.reset();
    } catch (error) {
      showMessage("signupMessage", error.message);
    }
  });
}

function bindCustomerLogin() {
  const form = document.getElementById("loginForm");
  if (!form) return;

  form.addEventListener("submit", async event => {
    event.preventDefault();
    try {
      requireFirebaseConfig();
      const body = formData(form);
      const credential = await signInWithEmailAndPassword(auth, body.email, body.password);
      const profile = await getCurrentProfile();
      if (!profile || profile.role !== "customer") {
        await signOut(auth);
        throw new Error("This login is only for customers.");
      }
      if (profile.status !== "active") {
        await signOut(auth);
        throw new Error("Your account is blocked. Please contact the bank.");
      }
      window.location.href = "/dashboard.html";
    } catch (error) {
      showMessage("loginMessage", error.message);
    }
  });
}

function bindEmployeeLogin() {
  const form = document.getElementById("employeeLoginForm");
  if (!form) return;

  form.addEventListener("submit", async event => {
    event.preventDefault();
    try {
      requireFirebaseConfig();
      const body = formData(form);
      await signInWithEmailAndPassword(auth, body.email, body.password);
      const profile = await getCurrentProfile();
      if (!profile || !["staff", "manager"].includes(profile.role)) {
        await signOut(auth);
        throw new Error("Invalid employee credentials.");
      }
      window.location.href = profile.role === "manager" ? "/manager-dashboard.html" : "/staff-dashboard.html";
    } catch (error) {
      showMessage("employeeLoginMessage", error.message);
    }
  });
}

async function addTransaction(customerId, transaction) {
  const transactionRef = doc(collection(db, "transactions"));
  await setDoc(transactionRef, {
    customerId,
    relatedAccount: "",
    status: "success",
    createdAt: serverTimestamp(),
    ...transaction
  });
}

async function loadCustomerDashboard() {
  if (document.body.dataset.page !== "customer-dashboard") return;
  setupLogout();
  await requireRole(["customer"], "/login.html");
  await refreshCustomer();
  await loadTransactions("recentTransactions", 5);
  bindOperations();
}

async function refreshCustomer() {
  const profile = await getCurrentProfile();
  const fields = {
    customerName: profile.fullName,
    accountNumber: profile.accountNumber,
    accountType: profile.accountType,
    balance: money(profile.balance)
  };
  for (const [id, value] of Object.entries(fields)) {
    const element = document.getElementById(id);
    if (element) element.textContent = value;
  }
}

function bindOperations() {
  document.querySelectorAll(".tab-button").forEach(button => {
    button.addEventListener("click", () => {
      document.querySelectorAll(".tab-button").forEach(item => item.classList.remove("active"));
      document.querySelectorAll(".operation").forEach(item => item.classList.remove("active"));
      button.classList.add("active");
      const target = document.getElementById(button.dataset.target);
      if (target) target.classList.add("active");
    });
  });

  bindCustomerMoneyForm("depositForm", "deposit");
  bindCustomerMoneyForm("withdrawForm", "withdrawal");
  bindTransferForm();
}

function getAmount(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0) throw new Error("Enter a valid amount.");
  return Number(amount.toFixed(2));
}

function bindCustomerMoneyForm(formId, type) {
  const form = document.getElementById(formId);
  if (!form) return;

  form.addEventListener("submit", async event => {
    event.preventDefault();
    try {
      const amount = getAmount(new FormData(form).get("amount"));
      const customerRef = doc(db, "customers", auth.currentUser.uid);
      let balanceAfter = 0;

      await runTransaction(db, async tx => {
        const snap = await tx.get(customerRef);
        const customer = snap.data();
        if (customer.status !== "active") throw new Error("Account is blocked.");
        if (type === "withdrawal" && customer.balance < amount) throw new Error("Insufficient balance.");
        balanceAfter = Number((customer.balance + (type === "deposit" ? amount : -amount)).toFixed(2));
        tx.update(customerRef, { balance: balanceAfter });
      });

      const profile = await getCurrentProfile();
      await addTransaction(auth.currentUser.uid, {
        accountNumber: profile.accountNumber,
        type,
        amount,
        description: type === "deposit" ? "Money deposited" : "Money withdrawn",
        balanceAfter,
        performedBy: "customer"
      });

      showMessage("operationMessage", `${type === "deposit" ? "Deposit" : "Withdrawal"} successful.`, "success");
      form.reset();
      await refreshCustomer();
      await loadTransactions("recentTransactions", 5);
    } catch (error) {
      showMessage("operationMessage", error.message);
    }
  });
}

function bindTransferForm() {
  const form = document.getElementById("transferForm");
  if (!form) return;

  form.addEventListener("submit", async event => {
    event.preventDefault();
    try {
      const body = formData(form);
      const amount = getAmount(body.amount);
      const receiverAccount = body.receiverAccount.trim();
      const directorySnap = await getDoc(doc(db, "accountDirectory", receiverAccount));
      if (!directorySnap.exists()) throw new Error("Receiver account not found.");

      const receiverId = directorySnap.data().customerId;
      if (receiverId === auth.currentUser.uid) throw new Error("Cannot transfer to the same account.");

      const senderRef = doc(db, "customers", auth.currentUser.uid);
      const receiverRef = doc(db, "customers", receiverId);
      let senderAfter = 0;
      let receiverAfter = 0;
      let senderAccount = "";

      await runTransaction(db, async tx => {
        const senderSnap = await tx.get(senderRef);
        const receiverSnap = await tx.get(receiverRef);
        const sender = senderSnap.data();
        const receiver = receiverSnap.data();
        if (sender.balance < amount) throw new Error("Insufficient balance.");
        if (receiver.status !== "active") throw new Error("Receiver account is blocked.");
        senderAfter = Number((sender.balance - amount).toFixed(2));
        receiverAfter = Number((receiver.balance + amount).toFixed(2));
        senderAccount = sender.accountNumber;
        tx.update(senderRef, { balance: senderAfter });
        tx.update(receiverRef, { balance: receiverAfter });
      });

      await addTransaction(auth.currentUser.uid, {
        accountNumber: senderAccount,
        type: "transfer-debit",
        amount,
        description: `Transfer to ${receiverAccount}`,
        relatedAccount: receiverAccount,
        balanceAfter: senderAfter,
        performedBy: "customer"
      });
      await addTransaction(receiverId, {
        accountNumber: receiverAccount,
        type: "transfer-credit",
        amount,
        description: `Transfer from ${senderAccount}`,
        relatedAccount: senderAccount,
        balanceAfter: receiverAfter,
        performedBy: "customer"
      });

      showMessage("operationMessage", "Transfer completed successfully.", "success");
      form.reset();
      await refreshCustomer();
      await loadTransactions("recentTransactions", 5);
    } catch (error) {
      showMessage("operationMessage", error.message);
    }
  });
}

async function loadTransactions(tableId = "transactionsTable", rowLimit = 1000) {
  const transactionsQuery = query(
    collection(db, "transactions"),
    where("customerId", "==", auth.currentUser.uid),
    limit(rowLimit)
  );
  const snap = await getDocs(transactionsQuery);
  const transactions = snap.docs
    .map(item => ({ id: item.id, ...item.data() }))
    .sort((a, b) => timestampMs(b.createdAt) - timestampMs(a.createdAt));
  renderTransactions(tableId, transactions);
}

function timestampMs(value) {
  if (!value) return 0;
  if (value.toDate) return value.toDate().getTime();
  return new Date(value).getTime();
}

function renderTransactions(tableId, transactions) {
  const body = document.getElementById(tableId);
  if (!body) return;
  body.innerHTML = transactions.map(transaction => `
    <tr>
      <td>${dateTime(transaction.createdAt)}</td>
      <td>${transaction.type}</td>
      <td>${transaction.description}</td>
      <td>${money(transaction.amount)}</td>
      <td>${money(transaction.balanceAfter)}</td>
      <td><span class="badge">${transaction.status}</span></td>
    </tr>
  `).join("") || `<tr><td colspan="6">No transactions found.</td></tr>`;
}

async function loadTransactionsPage() {
  if (document.body.dataset.page !== "transactions") return;
  setupLogout();
  await requireRole(["customer"], "/login.html");
  await loadTransactions();
}

async function loadProfilePage() {
  if (document.body.dataset.page !== "profile") return;
  setupLogout();
  const profile = await requireRole(["customer"], "/login.html");
  for (const [key, value] of Object.entries(profile)) {
    const input = document.querySelector(`[name="${key}"]`);
    if (input) input.value = value;
  }

  const form = document.getElementById("profileForm");
  form.addEventListener("submit", async event => {
    event.preventDefault();
    try {
      const body = formData(form);
      await updateDoc(doc(db, "customers", auth.currentUser.uid), {
        fullName: body.fullName.trim(),
        phone: body.phone.trim(),
        address: body.address.trim()
      });
      showMessage("profileMessage", "Profile updated.", "success");
    } catch (error) {
      showMessage("profileMessage", error.message);
    }
  });
}

async function loadStaffPage() {
  if (document.body.dataset.page !== "staff-dashboard") return;
  setupLogout();
  const profile = await requireRole(["staff", "manager"], "/staff-login.html");
  const staffName = document.getElementById("staffName");
  if (staffName) staffName.textContent = `${profile.fullName} (${profile.role})`;
  bindStaffTools();
  await loadStaffCustomers();
  await loadStaffTransactions();
}

function bindStaffTools() {
  const searchForm = document.getElementById("customerSearchForm");
  if (searchForm) {
    searchForm.addEventListener("submit", async event => {
      event.preventDefault();
      await loadStaffCustomers(new FormData(searchForm).get("search"));
    });
  }
  bindEmployeeMoneyForm("staffDepositForm", "deposit");
  bindEmployeeMoneyForm("staffWithdrawForm", "withdrawal");
}

function bindEmployeeMoneyForm(formId, type) {
  const form = document.getElementById(formId);
  if (!form) return;

  form.addEventListener("submit", async event => {
    event.preventDefault();
    try {
      const profile = await getCurrentProfile();
      const body = formData(form);
      const amount = getAmount(body.amount);
      const accountNumber = body.accountNumber.trim();
      const customerSnap = await getDocs(query(collection(db, "customers"), where("accountNumber", "==", accountNumber), limit(1)));
      if (customerSnap.empty) throw new Error("Account not found.");
      const customerDoc = customerSnap.docs[0];
      const customer = customerDoc.data();
      if (customer.status !== "active") throw new Error("Account is blocked.");
      if (type === "withdrawal" && customer.balance < amount) throw new Error("Insufficient balance.");

      const balanceAfter = Number((customer.balance + (type === "deposit" ? amount : -amount)).toFixed(2));
      await updateDoc(customerDoc.ref, { balance: balanceAfter });
      await addTransaction(customerDoc.id, {
        accountNumber,
        type,
        amount,
        description: type === "deposit" ? "Counter deposit" : "Counter withdrawal",
        balanceAfter,
        performedBy: profile.role
      });

      showMessage("staffMessage", `${type === "deposit" ? "Deposit" : "Withdrawal"} processed.`, "success");
      form.reset();
      await loadStaffCustomers();
      await loadStaffTransactions();
    } catch (error) {
      showMessage("staffMessage", error.message);
    }
  });
}

async function loadStaffCustomers(search = "") {
  const snap = await getDocs(query(collection(db, "customers"), orderBy("createdAt", "desc")));
  const searchText = String(search || "").toLowerCase();
  const customers = snap.docs
    .map(item => ({ id: item.id, ...item.data() }))
    .filter(customer => !searchText || customer.fullName.toLowerCase().includes(searchText) || customer.email.includes(searchText) || customer.accountNumber.includes(searchText));

  const body = document.getElementById("customersTable");
  if (!body) return;
  body.innerHTML = customers.map(customer => `
    <tr>
      <td>${customer.accountNumber}</td>
      <td>${customer.fullName}<br><span class="muted">${customer.email}</span></td>
      <td>${customer.phone}</td>
      <td>${customer.accountType}</td>
      <td>${money(customer.balance)}</td>
      <td><span class="badge ${customer.status === "blocked" ? "blocked" : ""}">${customer.status}</span></td>
    </tr>
  `).join("") || `<tr><td colspan="6">No customers found.</td></tr>`;
}

async function loadStaffTransactions() {
  const snap = await getDocs(query(collection(db, "transactions"), orderBy("createdAt", "desc"), limit(200)));
  const body = document.getElementById("staffTransactionsTable");
  if (!body) return;
  body.innerHTML = snap.docs.map(item => item.data()).map(transaction => `
    <tr>
      <td>${dateTime(transaction.createdAt)}</td>
      <td>${transaction.accountNumber}</td>
      <td>${transaction.type}</td>
      <td>${money(transaction.amount)}</td>
      <td>${money(transaction.balanceAfter)}</td>
      <td>${transaction.performedBy}</td>
    </tr>
  `).join("") || `<tr><td colspan="6">No transactions found.</td></tr>`;
}

async function loadManagerPage() {
  if (document.body.dataset.page !== "manager-dashboard") return;
  setupLogout();
  await requireRole(["manager"], "/staff-login.html");
  bindStaffTools();
  bindManagerStatus();
  await loadStaffCustomers();
  await loadStaffTransactions();
  await loadManagerSummary();
}

async function loadManagerSummary() {
  const snap = await getDocs(collection(db, "customers"));
  const customers = snap.docs.map(item => item.data());
  const summary = {
    customers: customers.length,
    activeCustomers: customers.filter(customer => customer.status === "active").length,
    blockedCustomers: customers.filter(customer => customer.status === "blocked").length,
    totalBalance: customers.reduce((sum, customer) => sum + Number(customer.balance || 0), 0)
  };
  for (const [key, value] of Object.entries(summary)) {
    const element = document.getElementById(key);
    if (element) element.textContent = key === "totalBalance" ? money(value) : value;
  }
}

function bindManagerStatus() {
  const form = document.getElementById("statusForm");
  if (!form) return;

  form.addEventListener("submit", async event => {
    event.preventDefault();
    try {
      const body = formData(form);
      const accountNumber = body.accountNumber.trim();
      const status = body.status;
      const customerSnap = await getDocs(query(collection(db, "customers"), where("accountNumber", "==", accountNumber), limit(1)));
      if (customerSnap.empty) throw new Error("Customer not found.");
      const customerDoc = customerSnap.docs[0];
      await updateDoc(customerDoc.ref, { status });
      await setDoc(doc(db, "accountDirectory", accountNumber), { status }, { merge: true });
      showMessage("managerMessage", `Customer account ${status}.`, "success");
      form.reset();
      await loadStaffCustomers();
      await loadManagerSummary();
    } catch (error) {
      showMessage("managerMessage", error.message);
    }
  });
}

document.addEventListener("DOMContentLoaded", () => {
  try {
    requireFirebaseConfig();
    setupLogout();
    bindSignup();
    bindCustomerLogin();
    bindEmployeeLogin();
    loadCustomerDashboard().catch(error => showMessage("operationMessage", error.message));
    loadTransactionsPage().catch(error => console.error(error));
    loadProfilePage().catch(error => showMessage("profileMessage", error.message));
    loadStaffPage().catch(error => showMessage("staffMessage", error.message));
    loadManagerPage().catch(error => showMessage("managerMessage", error.message));
  } catch (error) {
    for (const id of ["signupMessage", "loginMessage", "employeeLoginMessage", "operationMessage", "profileMessage", "staffMessage", "managerMessage"]) {
      showMessage(id, error.message);
    }
  }
});
