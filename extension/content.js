// Adds a "Video" button next to Send in every Gmail compose window.
// Clicking it opens __COMPANY__ Video in a small window to record or pick a
// video; the moving preview is then dropped into the email where you were typing.
(function () {
  const SERVER = "__SERVER__"; // filled in when the button is packaged
  let target = null; // { body, range } of the compose window that asked

  function composeBodies() {
    return document.querySelectorAll(
      'div[contenteditable="true"][role="textbox"][g_editable="true"], div[aria-label="Message Body"][contenteditable="true"]'
    );
  }

  // Walk up from the message body to the compose window holding its Send button.
  function composeRoot(body) {
    let el = body;
    for (let i = 0; i < 25 && el; i++, el = el.parentElement) {
      if (el.querySelector && el.querySelector('[role="button"][data-tooltip^="Send"], [role="button"][aria-label^="Send"]')) return el;
    }
    return null;
  }

  function firstRecipient(root) {
    // Recipient "chips" carry the address in an email or data-hovercard-id attribute.
    const chip = root.querySelector('[name="to"] [email], [name="to"] [data-hovercard-id], div[aria-label^="To"] [email], [data-hovercard-id*="@"]');
    if (chip) {
      const email = chip.getAttribute("email") || chip.getAttribute("data-hovercard-id") || "";
      const name = chip.getAttribute("name") || chip.textContent.replace(email, "").replace(/[<>]/g, "").trim();
      return { email, name: name && name !== email ? name : "" };
    }
    const input = root.querySelector('input[name="to"], textarea[name="to"]');
    const raw = input ? input.value : "";
    const m = raw.match(/[^\s<,]+@[^\s>,]+/);
    return { email: m ? m[0] : "", name: "" };
  }

  function addButtons() {
    composeBodies().forEach((body) => {
      const root = composeRoot(body);
      if (!root || root.querySelector(".ss-video-btn")) return;
      const send = root.querySelector('[role="button"][data-tooltip^="Send"], [role="button"][aria-label^="Send"]');
      const cell = send && send.closest("td") ? send.closest("td") : send && send.parentElement;
      if (!cell) return;
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "ss-video-btn";
      btn.title = "Add a __COMPANY__ video";
      btn.innerHTML = '<span class="ss-dot"></span>Video';
      // Remember where the cursor was before the click moves focus away.
      btn.addEventListener("mousedown", () => {
        const sel = window.getSelection();
        const range = sel.rangeCount && body.contains(sel.anchorNode) ? sel.getRangeAt(0).cloneRange() : null;
        target = { body, range };
      });
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (!target || target.body !== body) target = { body, range: null };
        const who = firstRecipient(root);
        // Everyone on the email (To, Cc, Bcc) shares one link, so say so in the name:
        // alerts then read "Jordan + 3 others opened" instead of naming one person.
        const everyone = new Set([...root.querySelectorAll('[name="to"] [email], [name="cc"] [email], [name="bcc"] [email], div[aria-label^="To"] [email], div[aria-label^="Cc"] [email], div[aria-label^="Bcc"] [email], [data-hovercard-id*="@"]')]
          .filter((el) => !el.closest('[contenteditable="true"]'))
          .map((el) => (el.getAttribute("email") || el.getAttribute("data-hovercard-id") || "").toLowerCase()).filter(Boolean));
        const others = Math.max(0, everyone.size - 1);
        const label = (who.name || who.email) + (others ? ` + ${others} other${others === 1 ? "" : "s"}` : "");
        const url = SERVER + "/app#/pick?to=" + encodeURIComponent(others ? "" : who.email) + "&name=" + encodeURIComponent(label);
        window.open(url, "ssvideo", "width=1080,height=780");
      });
      cell.insertAdjacentElement("afterend", wrapInCell(cell, btn));
    });
  }

  function wrapInCell(cell, btn) {
    if (cell.tagName !== "TD") return btn;
    const td = document.createElement("td");
    td.appendChild(btn);
    return td;
  }

  window.addEventListener("message", (e) => {
    if (e.origin !== SERVER || !e.data || e.data.type !== "ss-video-insert" || !target) return;
    const { body, range } = target;
    body.focus();
    const sel = window.getSelection();
    sel.removeAllRanges();
    if (range && body.contains(range.startContainer)) {
      sel.addRange(range);
    } else {
      const end = document.createRange();
      end.selectNodeContents(body);
      end.collapse(false);
      sel.addRange(end);
    }
    document.execCommand("insertHTML", false, e.data.html + "<br>");
    body.dispatchEvent(new Event("input", { bubbles: true }));
  });

  // Gmail changes the page constantly; check for new compose windows at most every half second.
  let pending = false;
  new MutationObserver(() => {
    if (pending) return;
    pending = true;
    setTimeout(() => { pending = false; addButtons(); }, 500);
  }).observe(document.body, { childList: true, subtree: true });
  addButtons();
})();
