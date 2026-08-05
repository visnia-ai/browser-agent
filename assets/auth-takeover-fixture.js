(function () {
	const acceptedUsername = "operator@example.com";
	const acceptedPassword = "correct-horse-battery-staple";
	const params = new URLSearchParams(window.location.search);
	const scenarioParam = params.get("scenario") || "success";
	const scenario =
		scenarioParam === "otp" ||
		scenarioParam === "success-email-first" ||
		scenarioParam === "otp-email-first" ||
		scenarioParam === "success-account-list"
			? scenarioParam
			: "success";
	const mode = scenario.includes("account-list")
		? "account-list"
		: scenario.includes("email-first")
			? "email-first"
			: "single-step";
	const outcome = scenario.startsWith("otp") ? "otp" : "success";

	const state = {
		scenario,
		mode,
		page: "login",
		authStep:
			mode === "account-list"
				? "account"
				: mode === "email-first"
					? "identifier"
					: "credentials",
		loginSuccess: false,
		manualStepRequired: false,
		invalidCredentialCount: 0,
		submittedCount: 0,
		lastAuthOutcome: "idle",
		lastSubmittedPasswordLength: 0,
		lastUsernameAccepted: false,
		lastIdentifier: "",
	};

	const loginShell = document.getElementById("login-shell");
	const appShell = document.getElementById("app-shell");
	const otpShell = document.getElementById("otp-shell");
	const authStatus = document.getElementById("auth-status");
	const scenarioBanner = document.getElementById("scenario-banner");
	const loginForm = document.getElementById("login-form");
	const formFields = document.getElementById("form-fields");
	const loginSubmit = document.getElementById("login-submit");
	const stepCopy = document.getElementById("step-copy");

	window.__authFixtureState = state;

	function setStatus(text, kind) {
		if (!authStatus) return;
		authStatus.textContent = text;
		authStatus.dataset.state = kind;
	}

	function getUsernameInput() {
		return document.getElementById("login-username");
	}

	function getPasswordInput() {
		return document.getElementById("login-password");
	}

	function selectExistingAccount() {
		showPasswordStep(acceptedUsername);
	}

	function resetFields() {
		const usernameInput = getUsernameInput();
		const passwordInput = getPasswordInput();
		if (usernameInput) {
			usernameInput.value = "";
		}
		if (passwordInput) {
			passwordInput.value = "";
		}
	}

	function showPasswordStep(identifier) {
		state.authStep = "credentials";
		state.lastIdentifier = identifier;
		if (stepCopy) {
			stepCopy.textContent =
				"Password required. Continue with your account password.";
		}
		if (loginSubmit) {
			loginSubmit.textContent = "Sign in";
		}
		render();
		const usernameInput = getUsernameInput();
		if (usernameInput) {
			usernameInput.value = identifier;
		}
		setStatus("Enter your account password.", "idle");
	}

	function showInvalidCredentialError(message, kind) {
		state.page = "login";
		state.loginSuccess = false;
		state.manualStepRequired = false;
		state.invalidCredentialCount += 1;
		state.lastAuthOutcome = "invalid_credentials";
		setStatus(message, kind);
		render();
	}

	function render() {
		if (scenarioBanner) {
			const description =
				scenario === "success"
					? "Single-step login succeeds with automated credential entry."
					: scenario === "otp"
						? "Single-step login reaches an OTP-style manual step."
						: scenario === "success-email-first"
							? "Email-first login advances to password, then succeeds with automated credential entry."
							: scenario === "success-account-list"
								? "Account chooser advances directly to password, then succeeds with automated credential entry."
								: "Email-first login advances to password, then reaches an OTP-style manual step.";
			scenarioBanner.textContent = `Scenario: ${description}`;
			scenarioBanner.dataset.kind = outcome;
		}

		if (formFields) {
			if (state.authStep === "account") {
				formFields.innerHTML = `
					<div class="field" id="account-chooser">
						<span>Choose an account</span>
						<button id="existing-account" type="button">
							<span>Operator Example</span>
							<span>${acceptedUsername}</span>
						</button>
						<button id="another-account" type="button">
							Use another account
						</button>
					</div>
				`;
				const existingAccount =
					document.getElementById("existing-account");
				if (existingAccount) {
					existingAccount.addEventListener(
						"click",
						selectExistingAccount,
					);
				}
				const anotherAccount = document.getElementById("another-account");
				if (anotherAccount) {
					anotherAccount.addEventListener("click", () => {
						state.authStep = "identifier";
						state.lastIdentifier = "";
						render();
						setStatus("Enter your email address to continue.", "idle");
					});
				}
				if (loginSubmit) {
					loginSubmit.classList.add("hidden");
				}
				return;
			}

			const usernameMarkup =
				mode === "account-list" && state.authStep === "credentials"
					? `
						<div class="field" id="selected-account">
							<span>Signed in as</span>
							<strong>${state.lastIdentifier}</strong>
						</div>
					`
					: `
						<div class="field" id="username-field">
							<span>Email address</span>
							<input id="login-username" name="username" type="email" autocomplete="username"
								placeholder="name@example.com" />
						</div>
					`;
			const passwordMarkup =
				state.authStep === "credentials"
					? `
						<div class="field" id="password-field">
							<span>Password</span>
							<input id="login-password" name="password" type="password"
								autocomplete="current-password" placeholder="Password" />
						</div>
					`
					: "";
			formFields.innerHTML = `
				${usernameMarkup}
				${passwordMarkup}
			`;
			const usernameInput = getUsernameInput();
			if (usernameInput && state.lastIdentifier) {
				usernameInput.value = state.lastIdentifier;
			}
		}
		if (loginSubmit) {
			loginSubmit.classList.remove("hidden");
			loginSubmit.textContent =
				state.authStep === "identifier" ? "Continue" : "Sign in";
		}

		if (loginShell) {
			loginShell.classList.toggle("hidden", state.page !== "login");
		}
		if (appShell) {
			appShell.classList.toggle("hidden", state.page !== "dashboard");
		}
		if (otpShell) {
			otpShell.classList.toggle("hidden", state.page !== "otp");
		}
	}

	function handleSuccessfulCredentialSubmit() {
		setStatus(
			outcome === "success"
				? "Authentication succeeded."
				: "Additional verification is required.",
			"idle",
		);
		resetFields();

		if (outcome === "success") {
			if (appShell) {
				appShell.innerHTML = `
					<p class="eyebrow">Dashboard</p>
					<h2>Dashboard Ready</h2>
					<p id="app-message">
						Authentication succeeded. The protected application is now visible.
					</p>
				`;
			}
			state.page = "dashboard";
			state.loginSuccess = true;
			state.manualStepRequired = false;
			state.lastAuthOutcome = "success";
			render();
			return;
		}

		if (otpShell) {
			otpShell.innerHTML = `
				<p class="eyebrow">Manual Step</p>
				<h2>Manual takeover required</h2>
				<p id="otp-message">
					Enter the one-time code from your authenticator app to continue.
				</p>
			`;
		}
		state.page = "otp";
		state.loginSuccess = false;
		state.manualStepRequired = true;
		state.lastAuthOutcome = "otp_required";
		render();
	}

	if (loginForm) {
		loginForm.addEventListener("submit", (event) => {
			event.preventDefault();
			const usernameInput = getUsernameInput();
			const passwordInput = getPasswordInput();
			if (!usernameInput && state.authStep !== "credentials") {
				return;
			}

			const username = usernameInput
				? usernameInput.value.trim()
				: state.lastIdentifier;
			const password = passwordInput ? passwordInput.value : "";

			if (state.authStep === "identifier") {
				state.submittedCount += 1;
				state.lastIdentifier = username;
				showPasswordStep(username);
				return;
			}

			state.submittedCount += 1;
			state.lastSubmittedPasswordLength = password.length;
			state.lastUsernameAccepted = username === acceptedUsername;

			if (
				username === acceptedUsername &&
				password === acceptedPassword
			) {
				handleSuccessfulCredentialSubmit();
				return;
			}

			showInvalidCredentialError("Invalid email or password.", "error");
		});
	}

	if (stepCopy) {
		stepCopy.textContent =
			mode === "account-list"
				? "Choose an account to continue."
				: mode === "email-first"
				? "Enter your email address to continue."
				: "Enter your account credentials.";
	}
	setStatus(
		mode === "account-list"
			? "Choose an account to continue."
			: mode === "email-first"
			? "Enter your email address to continue."
			: "Enter your account credentials.",
		"idle",
	);
	render();
})();
