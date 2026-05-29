// ==================== QUICK ACCESS MANAGEMENT SYSTEM ==================== //

class QuickAccessManager {
  constructor() {
    this.userId = this.getUserId();
    this.userRole = this.getUserRole();
    this.quickAccessItems = [];
    this.draggedIndex = null;
    this.longPressTimer = null;
    this.isDraggingEnabled = false;
    this.isActuallyDragging = false;
    this.longPressActivated = false;
    this.touchStartPos = null;
    this.userAccessibleMenus = []; // NEW: Store user's accessible menus from backend
    this.restrictedSections = [];

    // Define position-based colors (these stay fixed per position)
    this.positionColors = [
      "bg-[#8CB5F8]/20", // Position 0 - Blue
      "bg-[#FBBF24]/20", // Position 1 - Yellow
      "bg-[#FBBF24]/20", // Position 2 - Yellow
      "bg-[#8CB5F8]/20", // Position 3 - Blue
      "bg-[#8CB5F8]/20", // Position 4 - Blue
      "bg-[#FBBF24]/20", // Position 5 - Yellow
    ];

    // Define all available quick access options (maps to menu_key in database)
    this.availableOptions = {
      /*'dashboard': {
        id: 'dashboard',
        label: 'Dashboard',
        section: 'dashboard',
        title: 'Dashboard'
      },*/

      // Administration options
      "role-management": {
        id: "role-management",
        label: "Role Management",
        section: "role-management",
        title: "Role Management",
      },
      "create-user": {
        id: "create-user",
        label: "Create Payroll User",
        section: "create-user",
        title: "Create Payroll User",
      },
      "control-user": {
        id: "control-user",
        label: "Control Payroll Users",
        section: "control-user",
        title: "Control Payroll Users",
      },
      "payroll-class-setup": {
        id: "payroll-class-setup",
        label: "Payroll Class Setup",
        section: "payroll-class-setup",
        title: "Payroll Class Setup",
      },
      "switch-payroll-class": {
        id: "switch-payroll-class",
        label: "Switch Payroll Class",
        section: "switch-payroll-class",
        title: "Switch Active Payroll Class",
      },
      "change-payroll-class": {
        id: "change-payroll-class",
        label: "Change Payroll Class",
        section: "change-payroll-class",
        title: "Change Personnel Payroll Class",
      },
      "change-registration-number": {
        id: "change-registration-number",
        label: "Change Regno.",
        section: "change-registration-number",
        title: "Change Registration Number",
      },

      //(Adimn submenu - Irregular one-off payments
      "report-requirement-setup": {
        id: "report-requirement-setup",
        label: "Oneoff Payment Setup",
        section: "report-requirement-setup",
        title: "One-Off Requirement Setup",
      },
      "one-off-fixed-amount": {
        id: "one-off-fixed-amount",
        label: "Oneoff Fixed Amount",
        section: "one-off-fixed-amount",
        title: "One-Off Fixed Amount By Rank",
      },
      "individual-payment-input": {
        id: "individual-payment-input",
        label: "Individual Payment Input",
        section: "individual-payment-input",
        title: "Individual One-Off Payment Input",
      },
      "irregular-one-off-calculations": {
        id: "irregular-one-off-calculations",
        label: "One-Off Calculations",
        section: "irregular-one-off-calculations",
        title: "One-Off Calculations",
      },
      "irregular-one-off-reports": {
        id: "irregular-one-off-reports",
        label: "One-Off Reports",
        section: "irregular-one-off-reports",
        title: "One-Off Reports",
      },
      // End of subsubmenus)

      "company-profile": {
        id: "company-profile",
        label: "Company Profile",
        section: "company-profile",
        title: "Company Profile",
      },
      "monthly-yearly-processing": {
        id: "monthly-yearly-processing",
        label: "Month End Processing",
        section: "monthly-yearly-processing",
        title: "Month End Processing",
      },
      "yearly-processing": {
        id: "yearly-processing",
        label: "Year End Processing",
        section: "yearly-processing",
        title: "Year End Processing",
      },

      // Personnel profile options
      "add-personnel": {
        id: "add-personnel",
        label: "Add New Personnel",
        section: "add-personnel",
        title: "Add New Personnel",
      },
      "current-personnel": {
        id: "current-personnel",
        label: "Current Personnel",
        section: "current-personnel",
        title: "Current Personnel",
      },
      "old-personnel": {
        id: "old-personnel",
        label: "Old Personnel",
        section: "old-personnel",
        title: "Old Personnel",
      },
      /*"view-personnel": {
        id: "view-personnel",
        label: "View Personnel",
        section: "view-personnel",
        title: "View Personnel",
      },*/

      // Data input options
      "payments-deductions": {
        id: "payments-deductions",
        label: "Payment/Deduction",
        section: "payments-deductions",
        title: "Payments/Deductions",
      },
      "payments-deductions-upload": {
        id: "payments-deductions-upload",
        label: "Pay/Ded Upload",
        section: "payments-deductions-upload",
        title: "Payments/Deductions Upload",
      },
      "variation-payments": {
        id: "variation-payments",
        label: "Variation-To Pay/Ded",
        section: "variation-payments",
        title: "Variation to Payments/Deductions",
      },
      "cumulative-payroll": {
        id: "cumulative-payroll",
        label: "Cumulative Payroll",
        section: "cumulative-payroll",
        title: "Cumulative Payroll Transfer",
      },
      "input-documentation": {
        id: "input-documentation",
        label: "Input Documentation",
        section: "input-documentation",
        title: "Input Documentation",
      },
      "arrears-calculations": {
        id: "arrears-calculations",
        label: "Arrears Calculations",
        section: "arrears-calculations",
        title: "Arrears Calculations",
      },
      "adjustments": {
        id: "adjustments",
        label: "PayHead Adjustments",
        section: "adjustments",
        title: "Pay Heads Adjustments",
      },

      // File update options
      "save-payroll-files": {
        id: "save-payroll-files",
        label: "Save Payroll Files",
        section: "save-payroll-files",
        title: "Save Payroll Files",
      },
      "changes-personnel-data": {
        id: "changes-personnel-data",
        label: "Changes Personnel Data",
        section: "changes-personnel-data",
        title: "Changes Personnel Data",
      },
      "input-variable-report": {
        id: "input-variable-report",
        label: "Input Variable",
        section: "input-variable-report",
        title: "Input Variable Report",
      },
      "master-file-update": {
        id: "master-file-update",
        label: "Master File Update",
        section: "master-file-update",
        title: "Master File Update",
      },
      "recall-payment-files": {
        id: "recall-payment-files",
        label: "Recall Files",
        section: "recall-payment-files",
        title: "Recall Payment Files",
      },

      // Payroll calculations options
      "payroll-calculations": {
        id: "payroll-calculations",
        label: "Payroll Calculations",
        section: "payroll-calculations",
        title: "Payroll Calculations",
      },
      "calculation-reports": {
        id: "calculation-reports",
        label: "Calculation Reports",
        section: "calculation-reports",
        title: "Calculation Reports",
      },

      // Reference tables options
      "overtime-information": {
        id: "overtime-information",
        label: "Overtime",
        section: "overtime-information",
        title: "Overtime Information",
      },
      command: {
        id: "command",
        label: "Command",
        section: "command",
        title: "Command",
      },
      "cash-payment": {
        id: "cash-payment",
        label: "Overpayment Percentage",
        section: "cash-payment",
        title: "Overpayment Percentage Alarm",
      },
      "tax-table-information": {
        id: "tax-table-information",
        label: "Tax Table",
        section: "tax-table-information",
        title: "Tax Table Information",
      },
      "salary-scale-information": {
        id: "salary-scale-information",
        label: "Salary Scale",
        section: "salary-scale-information",
        title: "Salary Scale Information",
      },
      "pay-element-description": {
        id: "pay-element-description",
        label: "Pay Elements",
        section: "pay-element-description",
        title: "Pay Element Description",
      },
      "fixed-amount-rank": {
        id: "fixed-amount-rank",
        label: "Fixed Amount Rank",
        section: "fixed-amount-rank",
        title: "Fixed Amount per Rank",
      },
      "mutually-exclusive": {
        id: "mutually-exclusive",
        label: "Mutually Exclusive",
        section: "mutually-exclusive",
        title: "Mutually Exclusive Pay Elements",
      },
      "pension-fund-administrator": {
        id: "pension-fund-administrator",
        label: "PFA",
        section: "pension-fund-administrator",
        title: "Pension Fund Administrator",
      },
      "bank-details": {
        id: "bank-details",
        label: "Bank Details",
        section: "bank-details",
        title: "Bank Details",
      },
      department: {
        id: "department",
        label: "Department",
        section: "department",
        title: "Department",
      },
      "state-codes": {
        id: "state-codes",
        label: "State Codes",
        section: "state-codes",
        title: "State Codes",
      },
      "local-government": {
        id: "local-government",
        label: "Local Government",
        section: "local-government",
        title: "Local Government",
      },

      // Utilities
      "emolument-form-processing": {
        id: "emolument-form-processing",
        label: "Emolument Form",
        section: "emolument-form-processing",
        title: "Emolument Form Processing",
      },
      "ippis-payments": {
        id: "ippis-payments",
        label: "IPPIS Payments",
        section: "ippis-payments",
        title: "Pull IPPIS Payments",
      },
      "consolidated-payslip": {
        id: "consolidated-payslip",
        label: "Consolidated Payslip",
        section: "consolidated-payslip",
        title: "Consolidated Payslip",
      },
      "database-backup": {
        id: "database-backup",
        label: "Payroll Class Backup",
        section: "database-backup",
        title: "Payroll Class Backup",
      },
      "database-restore": {
        id: "database-restore",
        label: "Payroll Class Restore",
        section: "database-restore",
        title: "Payroll Class Restore",
      },

      // Reports
      "pay-slips": {
        id: "pay-slips",
        label: "Payslips",
        section: "pay-slips",
        title: "Payslips",
      },
      "payments-by-bank": {
        id: "payments-by-bank",
        label: "Payments by Bank",
        section: "payments-by-bank",
        title: "Payments by Bank",
      },
      "analysis-of-earnings": {
        id: "analysis-of-earnings",
        label: "Earnings Analysis",
        section: "analysis-of-earnings",
        title: "Analysis of Earnings",
      },
      "loan-analysis": {
        id: "loan-analysis",
        label: "Loan Analysis",
        section: "loan-analysis",
        title: "Loan Analysis",
      },
      "analysis-of-payments": {
        id: "analysis-of-payments",
        label: "Payments Analysis",
        section: "analysis-of-payments",
        title: "Analysis of Payments/Deductions by Bank",
      },
      "tax-payments-by-state": {
        id: "tax-payments-by-state",
        label: "Tax Payments",
        section: "tax-payments-by-state",
        title: "Tax Payments by State",
      },
      "payroll-register": {
        id: "payroll-register",
        label: "Payroll Register",
        section: "payroll-register",
        title: "Payroll Register",
      },
      "national-housing-funds": {
        id: "national-housing-funds",
        label: "NHF",
        section: "national-housing-funds",
        title: "National Housing Funds",
      },
      nsitf: {
        id: "nsitf",
        label: "NSITF",
        section: "nsitf",
        title: "Pension Fund Scheme",
      },
      "salary-summary": {
        id: "salary-summary",
        label: "Salary Summary",
        section: "salary-summary",
        title: "Salary Summary",
      },
      "salary-reconciliation": {
        id: "salary-reconciliation",
        label: "Salary Reconciliation",
        section: "salary-reconciliation",
        title: "Salary Reconciliation",
      },
      "salary-history": {
        id: "salary-history",
        label: "Salary History",
        section: "salary-history",
        title: "Salary History",
      },
      "control-sheet": {
        id: "control-sheet",
        label: "Control Sheet",
        section: "control-sheet",
        title: "Control Sheet/Journal",
      },
      "personnel-reports": {
        id: "personnel-reports",
        label: "Personnel Reports",
        section: "personnel-reports",
        title: "Personnel Reports",
      },
      "listof-exited-members": {
        id: "listof-exited-members",
        label: "Exited Members",
        section: "listof-exited-members",
        title: "List of Exited Members",
      },

      // Audit trail
      "salary-variance-analysis": {
        id: "salary-variance-analysis",
        label: "Salary Variance",
        section: "salary-variance-analysis",
        title: "Salary Variance Analysis",
      },
      "changes-in-personal-details": {
        id: "changes-in-personal-details",
        label: "Changes Personal Details",
        section: "changes-in-personal-details",
        title: "Changes in Personal Details",
      },
      "variation-input-listings": {
        id: "variation-input-listings",
        label: "Variation Input",
        section: "variation-input-listings",
        title: "Variation Input Listings",
      },
      overpayment: {
        id: "overpayment",
        label: "Overpayment",
        section: "overpayment",
        title: "Overpayment",
      },
      "duplicate-account-number": {
        id: "duplicate-account-number",
        label: "Duplicate Acc.No",
        section: "duplicate-account-number",
        title: "Duplicate Account Number",
      },
      "outof-range-payments": {
        id: "outof-range-payments",
        label: "Out-of-Range Payments",
        section: "outof-range-payments",
        title: "Out-of-Range Payments",
      },
    };

    // Define default quick access items (fallback if backend has no data)
    this.roleDefaults = {
      HICAD: [
        "save-payroll-files",
        "calculation-reports",
        "database-backup",
        "monthly-yearly-processing",
        "payments-deductions",
        "pay-slips",
      ],
      MANAGER: [
        "pay-slips",
        "ippis-payments",
        "irregular-one-off-calculations",
        "salary-scale-information",
        "current-personnel",
        "save-payroll-files",
      ],
      PROCESSOR: [
        "payments-deductions",
        "pay-slips",
        "current-personnel",
        "database-backup",
        "save-payroll-files",
        "monthly-yearly-processing",
      ],
      OPERATOR: [
        "add-personnel",
        "current-personnel",
        "payments-deductions",
        "database-backup",
        "personnel-reports",
        "duplicate-account-number",
      ],
      DATA_ENTRY: [
        "payments-deductions-upload",
        "current-personnel",
        "personnel-reports",
        "input-documentation",
        "add-personnel",
        "database-backup",
      ],
    };

    this.init();
  }

  getRestrictedSections() {
    // Sections hidden when payroll stage >= 666
    return [
      "payments-deductions",
      "payments-deductions-upload",
      "variation-payments",
      "cumulative-payroll",
      "input-documentation",
      "arrears-calculations",
      "adjustments",
      "add-personnel",
      "current-personnel",
      "old-personnel",
    ];
  }

  isPayrollProcessing() {
    return (
      typeof window.getCurrentPayrollStage === "function" &&
      window.getCurrentPayrollStage() >= 666
    );
  }

  getUserId() {
    return localStorage.getItem("user_id") || "default";
  }

  getUserRole() {
    return localStorage.getItem("role");
  }

  // NEW: Fetch user's accessible menus from backend
  async loadUserAccessibleMenus() {
    try {
      const token = localStorage.getItem("token");
      if (!token) {
        console.warn("No token found, skipping menu permissions fetch");
        return;
      }

      const response = await fetch("/roles/my-menus", {
        method: "GET",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
      });

      if (response.ok) {
        const menus = await response.json();
        this.userAccessibleMenus = menus.map((m) => m.menu_key);
        console.log(
          "📋 Loaded accessible menus from backend:",
          this.userAccessibleMenus,
        );
      } else {
        console.error("Failed to load accessible menus");
        this.userAccessibleMenus = [];
      }
    } catch (error) {
      console.error("Error loading accessible menus:", error);
      this.userAccessibleMenus = [];
    }
  }

  // NEW: Get available options filtered by user's actual permissions
  getAvailableOptionsForRole() {
    // If no accessible menus loaded (error or no permissions), show nothing
    if (this.userAccessibleMenus.length === 0) {
      console.warn("No accessible menus loaded");
      return {};
    }

    // Filter options to only include menus user has access to
    const filtered = {};
    const restricted = this.isPayrollProcessing()
      ? this.getRestrictedSections()
      : [];

    Object.entries(this.availableOptions).forEach(([id, option]) => {
      if (this.userAccessibleMenus.includes(id) && !restricted.includes(id)) {
        filtered[id] = option;
      }
    });

    console.log(
      "✅ Available quick access options for user:",
      Object.keys(filtered),
    );
    return filtered;
  }

  async init() {
    // Load user's accessible menus first
    await this.loadUserAccessibleMenus();

    // Then load quick access preferences
    await this.loadQuickAccess();

    // Validate and fix quick access items
    this.validateQuickAccessItems();

    this.render();

    window.addEventListener("payrollStatusChanged", () => {
      // Re-render modal options if it's open
      const modal = document.getElementById("quickAccessModal");
      if (modal && !modal.classList.contains("hidden")) {
        this.renderModalContent();
      }
      // Re-render dashboard buttons (to reflect any restored items)
      this.render();
    });

    this.createModal();
  }

  // NEW: Validate that all quick access items are accessible to user
  validateQuickAccessItems() {
    // Only filter by role permissions — NOT by payroll stage
    const permittedIds = this.userAccessibleMenus;

    const validItems = this.quickAccessItems.filter((itemId) =>
      permittedIds.includes(itemId),
    );

    // If we lost items, fill with accessible defaults
    if (validItems.length < 6) {
      // Get defaults for this role
      const defaults = this.roleDefaults[this.userRole] || [];
      const validDefaults = defaults.filter((id) => permittedIds.includes(id));

      // Add defaults that aren't already in validItems
      for (const defaultId of validDefaults) {
        if (!validItems.includes(defaultId) && validItems.length < 6) {
          validItems.push(defaultId);
        }
      }

      for (const id of permittedIds) {
        if (!validItems.includes(id) && validItems.length < 6) {
          validItems.push(id);
        }
      }

      while (validItems.length < 6 && permittedIds.length > 0) {
        const firstAvailable =
          permittedIds[validItems.length % permittedIds.length];
        validItems.push(firstAvailable);
      }
    }

    this.quickAccessItems = validItems;

    if (validItems.length !== this.quickAccessItems.length) {
      this.saveQuickAccess();
    }
  }

  async loadQuickAccess() {
    try {
      const token = localStorage.getItem("token");
      if (!token) {
        this.useRoleDefaults();
        return;
      }

      const response = await fetch("/preferences", {
        method: "GET",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
      });

      if (response.ok) {
        const data = await response.json();

        if (
          data.success &&
          data.quickAccess &&
          Array.isArray(data.quickAccess) &&
          data.quickAccess.length === 6
        ) {
          this.quickAccessItems = data.quickAccess;
          console.log("📂 Loaded custom quick access from backend");
        } else {
          this.useRoleDefaults();
        }
      } else {
        this.useRoleDefaults();
      }
    } catch (error) {
      console.error("Failed to load quick access:", error);
      this.useRoleDefaults();
    }
  }

  useRoleDefaults() {
    const defaults =
      this.roleDefaults[this.userRole] || this.roleDefaults["DATA_ENTRY"];
    this.quickAccessItems = [...defaults];
    console.log(`🎯 Using default quick access for role: ${this.userRole}`);
  }

  async saveQuickAccess() {
    try {
      const token = localStorage.getItem("token");
      if (!token) return;

      const response = await fetch("/preferences/save", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          quickAccess: this.quickAccessItems,
        }),
      });

      if (response.ok) {
        console.log("💾 Saved quick access preferences to backend");
      }
    } catch (error) {
      console.error("Failed to save quick access:", error);
    }
  }

  createModal() {
    const modal = document.createElement("div");
    modal.id = "quickAccessModal";
    modal.className =
      "fixed inset-0 bg-black/50 backdrop-blur-sm hidden items-center justify-center z-50";
    modal.innerHTML = `
      <div class="bg-white rounded-xl shadow-2xl max-w-xl w-full mx-4">
        <div class="bg-navy p-4 text-white flex items-center justify-between rounded-t-xl">
          <h3 class="text-lg font-bold">Customize Quick Access</h3>
          <button 
            onclick="window.quickAccessManager.resetToDefaults()" 
            class="text-md font-bold text-yellow-300 hover:underline transition-colors">
            <i class="fa-solid fa-arrow-rotate-left mr-1"></i> Reset
          </button>
        </div>
        
        <div class="p-4">
          <div id="modalQuickAccessGrid" class="grid grid-cols-2 gap-3"></div>
        </div>
        
        <div class="bg-gray-50 p-3 flex justify-end gap-2 border-t rounded-b-xl">
          <button 
            onclick="window.quickAccessManager.closeModal()" 
            class="px-4 py-2 bg-gray-200 hover:bg-gray-300 text-gray-700 rounded-lg text-sm font-semibold transition-colors">
            Cancel
          </button>
          <button 
            onclick="window.quickAccessManager.saveAndClose()" 
            class="px-4 py-2 bg-green-600 hover:bg-green-700 text-white rounded-lg text-sm font-semibold transition-colors">
            Save
          </button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);

    this.createAlertModal();
  }

  createAlertModal() {
    const alertModal = document.createElement("div");
    alertModal.id = "quickAccessAlertModal";
    alertModal.className =
      "fixed inset-0 bg-black/50 backdrop-blur-sm hidden items-center justify-center z-50";
    alertModal.innerHTML = `
      <div class="bg-white rounded-xl shadow-2xl max-w-md w-full mx-4">
        <div class="p-6">
          <div class="flex items-center gap-3 mb-4">
            <div class="w-12 h-12 rounded-full bg-green-100 flex items-center justify-center">
              <i class="fa-solid fa-circle-info text-green-600 text-xl"></i>
            </div>
            <h3 class="text-lg font-bold text-navy" id="alertModalTitle">Confirm</h3>
          </div>
          <p class="text-gray-700 mb-6" id="alertModalMessage"></p>
          <div class="flex justify-end gap-2">
            <button 
              onclick="window.quickAccessManager.closeAlertModal(false)" 
              class="px-4 py-2 bg-gray-200 hover:bg-gray-300 text-gray-700 rounded-lg text-sm font-semibold transition-colors">
              Cancel
            </button>
            <button 
              onclick="window.quickAccessManager.closeAlertModal(true)" 
              class="px-4 py-2 bg-green-600 hover:bg-green-700 text-white rounded-lg text-sm font-semibold transition-colors">
              Confirm
            </button>
          </div>
        </div>
      </div>
    `;
    document.body.appendChild(alertModal);
  }

  showAlert(message, title = "Confirm") {
    return new Promise((resolve) => {
      this.alertResolve = resolve;
      const modal = document.getElementById("quickAccessAlertModal");
      const titleEl = document.getElementById("alertModalTitle");
      const messageEl = document.getElementById("alertModalMessage");

      if (modal && titleEl && messageEl) {
        titleEl.textContent = title;
        messageEl.textContent = message;
        modal.classList.remove("hidden");
        modal.classList.add("flex");
      }
    });
  }

  closeAlertModal(result) {
    const modal = document.getElementById("quickAccessAlertModal");
    if (modal) {
      modal.classList.add("hidden");
      modal.classList.remove("flex");
    }
    if (this.alertResolve) {
      this.alertResolve(result);
      this.alertResolve = null;
    }
  }

  openModal() {
    const modal = document.getElementById("quickAccessModal");
    if (!modal) return;

    this.renderModalContent();
    modal.classList.remove("hidden");
    modal.classList.add("flex");
  }

  closeModal() {
    const modal = document.getElementById("quickAccessModal");
    if (!modal) return;

    modal.classList.add("hidden");
    modal.classList.remove("flex");

    this.loadQuickAccess().then(() => {
      this.validateQuickAccessItems();
      this.render();
    });
  }

  async saveAndClose() {
    await this.saveQuickAccess();
    const modal = document.getElementById("quickAccessModal");
    if (modal) {
      modal.classList.add("hidden");
      modal.classList.remove("flex");
    }
    this.render();
  }

  renderModalContent() {
    const grid = document.getElementById("modalQuickAccessGrid");
    if (!grid) return;

    grid.innerHTML = this.quickAccessItems
      .map((itemId, index) => {
        const option = this.availableOptions[itemId];
        if (!option) return "";

        return this.renderModalItem(option, index);
      })
      .join("");
  }

  renderModalItem(option, index) {
    const color = this.positionColors[index];
    const roleOptions = this.getAvailableOptionsForRole();

    // Only show options user has access to
    const availableForSwap = Object.entries(roleOptions)
      .filter(([id]) => !this.quickAccessItems.includes(id) || id === option.id)
      .map(
        ([id, opt]) => `
        <option value="${id}" ${id === option.id ? "selected" : ""}>
          ${opt.label}
        </option>
      `,
      )
      .join("");

    return `
      <div 
        class="relative ${color} p-3 rounded-lg shadow-sm border-2 border-transparent hover:border-green-400 cursor-move transition-all modal-drag-item"
        draggable="true"
        data-index="${index}"
        ondragstart="window.quickAccessManager.handleModalDragStart(event, ${index})"
        ondragover="window.quickAccessManager.handleModalDragOver(event)"
        ondrop="window.quickAccessManager.handleModalDrop(event, ${index})"
        ondragend="window.quickAccessManager.handleModalDragEnd(event)"
        ondragleave="window.quickAccessManager.handleModalDragLeave(event)">
        
        <div class="flex flex-col gap-2">
          <div class="text-center text-sm font-semibold text-gray-700">
            ${option.label}
          </div>
          
          <select 
            onchange="window.quickAccessManager.replaceItemInModal(${index}, this.value)"
            class="w-full px-2 py-1.5 text-xs border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-green-500 bg-white cursor-pointer"
            onclick="event.stopPropagation()">
            ${availableForSwap}
          </select>
        </div>
      </div>
    `;
  }

  // ========== DRAG HANDLERS ==========

  clearLongPressTimer() {
    if (this.longPressTimer) {
      clearTimeout(this.longPressTimer);
      this.longPressTimer = null;
    }
  }

  resetDragState() {
    this.clearLongPressTimer();
    this.isDraggingEnabled = false;
    this.isActuallyDragging = false;
    this.draggedIndex = null;

    document.querySelectorAll(".quick-access-btn").forEach((btn) => {
      btn.setAttribute("draggable", "false");
      btn.style.cursor = "";
      btn.style.opacity = "";
      btn.style.transform = "";
      btn.style.borderColor = "";
      btn.style.borderWidth = "";
      btn.style.borderStyle = "";
    });
  }

  handleMouseDown(index, event) {
    const button = event.currentTarget;
    this.clearLongPressTimer();

    this.longPressTimer = setTimeout(() => {
      this.isDraggingEnabled = true;
      this.draggedIndex = index;
      button.setAttribute("draggable", "true");
      button.style.cursor = "grabbing";
      button.style.opacity = "0.7";
      button.style.transform = "scale(1.05)";

      if (navigator.vibrate) {
        navigator.vibrate(50);
      }
    }, 500);
  }

  handleMouseUp(event) {
    this.clearLongPressTimer();

    if (this.isDraggingEnabled && !this.isActuallyDragging) {
      event.preventDefault();
      event.stopPropagation();
    }

    setTimeout(() => {
      if (!this.isActuallyDragging) {
        this.resetDragState();
      }
    }, 150);
  }

  handleDashboardDragStart(index, event) {
    if (!this.isDraggingEnabled || this.draggedIndex !== index) {
      event.preventDefault();
      event.stopPropagation();
      return false;
    }

    this.isActuallyDragging = true;
    this.draggedIndex = index;
    event.dataTransfer.effectAllowed = "move";
    event.currentTarget.style.opacity = "0.4";
  }

  handleDashboardDragOver(event) {
    if (!this.isActuallyDragging) return;

    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    event.currentTarget.style.borderColor = "#3B82F6";
    event.currentTarget.style.borderWidth = "2px";
    event.currentTarget.style.borderStyle = "dashed";
  }

  handleDashboardDragLeave(event) {
    event.currentTarget.style.borderColor = "";
    event.currentTarget.style.borderWidth = "";
    event.currentTarget.style.borderStyle = "";
  }

  handleDashboardDrop(targetIndex, event) {
    event.preventDefault();
    event.currentTarget.style.borderColor = "";
    event.currentTarget.style.borderWidth = "";
    event.currentTarget.style.borderStyle = "";

    if (this.draggedIndex === null || this.draggedIndex === targetIndex) {
      this.draggedIndex = null;
      return;
    }

    const items = [...this.quickAccessItems];
    const temp = items[this.draggedIndex];
    items[this.draggedIndex] = items[targetIndex];
    items[targetIndex] = temp;

    this.quickAccessItems = items;
    this.draggedIndex = null;

    this.saveQuickAccess();
    this.render();
  }

  handleDashboardDragEnd(event) {
    event.currentTarget.style.opacity = "1";

    document.querySelectorAll(".quick-access-btn").forEach((el) => {
      el.style.borderColor = "";
      el.style.borderWidth = "";
      el.style.borderStyle = "";
      el.style.opacity = "";
    });

    setTimeout(() => {
      this.resetDragState();
    }, 100);
  }

  handleButtonClick(section, title, event) {
    if (this.isDraggingEnabled || this.isActuallyDragging) {
      event.preventDefault();
      event.stopPropagation();
      return false;
    }

    // Block restricted sections during payroll processing
    if (
      this.isPayrollProcessing() &&
      this.getRestrictedSections().includes(section)
    ) {
      this.showPayrollBlockedModal(title);
      return false;
    }

    if (window.navigation && window.navigation.navigateToSection) {
      window.navigation.navigateToSection(section, title);
    }
    return true;
  }

  showPayrollBlockedModal(sectionTitle) {
    // Reuse existing alert modal
    this.showAlert(
      `"${sectionTitle}" is not available while payroll processing is ongoing.`,
      "Section Unavailable",
    ).then(() => {}); // dismiss only, no confirm action needed

    // Swap confirm button to just "OK"
    const confirmBtn = document.querySelector(
      "#quickAccessAlertModal button:last-child",
    );
    const cancelBtn = document.querySelector(
      "#quickAccessAlertModal button:first-child",
    );
    if (confirmBtn) confirmBtn.textContent = "OK";
    if (cancelBtn) cancelBtn.style.display = "none";

    // Restore cancel button after close
    const original = this.closeAlertModal.bind(this);
    this.closeAlertModal = (result) => {
      if (cancelBtn) cancelBtn.style.display = "";
      if (confirmBtn) confirmBtn.textContent = "Confirm";
      this.closeAlertModal = original;
      original(result);
    };
  }

  handleModalDragStart(event, index) {
    this.draggedIndex = index;
    event.dataTransfer.effectAllowed = "move";
    event.currentTarget.style.opacity = "0.4";
  }

  handleModalDragOver(event) {
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    event.currentTarget.style.borderColor = "#3B82F6";
    event.currentTarget.style.borderWidth = "2px";
  }

  handleModalDragLeave(event) {
    event.currentTarget.style.borderColor = "transparent";
  }

  handleModalDragEnd(event) {
    event.currentTarget.style.opacity = "1";
    document.querySelectorAll(".modal-drag-item").forEach((el) => {
      el.style.borderColor = "transparent";
    });
  }

  handleModalDrop(event, targetIndex) {
    event.preventDefault();
    event.currentTarget.style.borderColor = "transparent";

    if (this.draggedIndex === null || this.draggedIndex === targetIndex) {
      this.draggedIndex = null;
      return;
    }

    const items = [...this.quickAccessItems];
    const temp = items[this.draggedIndex];
    items[this.draggedIndex] = items[targetIndex];
    items[targetIndex] = temp;

    this.quickAccessItems = items;
    this.draggedIndex = null;

    this.renderModalContent();
  }

  async replaceItemInModal(index, newItemId) {
    if (index < 0 || index >= 6) return;

    this.quickAccessItems[index] = newItemId;
    this.renderModalContent();
  }

  async resetToDefaults() {
    const confirmed = await this.showAlert(
      "Reset to default quick access items for your role?",
      "Reset Quick Access",
    );

    if (confirmed) {
      this.useRoleDefaults();
      this.validateQuickAccessItems(); // Ensure defaults are valid for user's permissions
      this.renderModalContent();
    }
  }

  render() {
    const container = document.querySelector(".frame-3");
    if (!container) return;

    const items = this.quickAccessItems
      .map((itemId, index) => {
        const option = this.availableOptions[itemId];
        if (!option) return "";

        const color = this.positionColors[index];

        return `
        <button 
          class="quick-access-btn ${color} py-3 rounded-lg shadow-custom font-semibold hover:shadow-lg transition-all select-none cursor-pointer"
          data-index="${index}"
          draggable="false"
          style="touch-action: none;">
          ${option.label}
        </button>
      `;
      })
      .join("");

    container.innerHTML = `
      <div class="flex items-center justify-center gap-3 mb-6">
        <h4 class="text-xl font-bold text-navy">Quick Access</h4>
        <button 
          onclick="window.quickAccessManager.openModal()" 
          class="text-navy hover:text-green-600 transition-colors text-sm font-semibold"
          title="Edit">
          <i class="fa-solid fa-pen-to-square"></i>
        </button>
      </div>
      <div class="grid grid-cols-2 gap-6">
        ${items}
      </div>
    `;

    this.attachEventListeners();
  }

  attachEventListeners() {
    const buttons = document.querySelectorAll(".quick-access-btn");

    buttons.forEach((button, index) => {
      const option = this.availableOptions[this.quickAccessItems[index]];
      if (!option) return;

      // Remove any existing listeners by cloning
      const newButton = button.cloneNode(true);
      button.parentNode.replaceChild(newButton, button);

      // Long press for enabling drag
      newButton.addEventListener("mousedown", (e) =>
        this.handleMouseDown(index, e),
      );
      newButton.addEventListener("mouseup", (e) => this.handleMouseUp(e));
      newButton.addEventListener("mouseleave", (e) => this.handleMouseUp(e));

      newButton.addEventListener(
        "touchstart",
        (e) => this.handleMouseDown(index, e),
        { passive: true },
      );
      newButton.addEventListener("touchend", (e) => this.handleMouseUp(e));
      newButton.addEventListener("touchcancel", (e) => this.handleMouseUp(e));

      // Standard drag events (work after long press enables draggable)
      newButton.addEventListener("dragstart", (e) =>
        this.handleDashboardDragStart(index, e),
      );
      newButton.addEventListener("dragover", (e) =>
        this.handleDashboardDragOver(e),
      );
      newButton.addEventListener("dragleave", (e) =>
        this.handleDashboardDragLeave(e),
      );
      newButton.addEventListener("drop", (e) =>
        this.handleDashboardDrop(index, e),
      );
      newButton.addEventListener("dragend", (e) =>
        this.handleDashboardDragEnd(e),
      );

      // Click for navigation
      newButton.addEventListener("click", (e) =>
        this.handleButtonClick(option.section, option.title, e),
      );
    });
  }
}

// Initialize on page load
document.addEventListener("DOMContentLoaded", () => {
  window.quickAccessManager = new QuickAccessManager();
  console.log("✅ Quick Access Manager initialized");
});
