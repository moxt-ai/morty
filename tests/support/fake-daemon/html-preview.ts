export const interactiveHtml = `<!doctype html>
<html lang="en">
<head>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Delivery review</title>
  <style>
    body { margin: 0; padding: 24px; font: 16px system-ui; color: #123b30; background: #f3faf6; }
    main { max-width: 640px; margin: auto; }
    label, output { display: block; margin: 20px 0 8px; }
    input, button { box-sizing: border-box; max-width: 100%; padding: 12px; font: inherit; }
    button { background: #176c50; color: white; border: 0; border-radius: 8px; }
  </style>
</head>
<body>
  <main>
    <h1>Delivery review</h1>
    <p>Inspect the result and continue the conversation.</p>
    <label for="name">Review name</label>
    <input id="name" value="Mobile review">
    <output id="result" aria-live="polite">Ready to review</output>
    <button id="approve">Review result</button>
    <p id="count">Reviews: 0</p>
  </main>
  <script>
    let reviews = 0;
    document.getElementById("approve").addEventListener("click", () => {
      document.getElementById("result").textContent = document.getElementById("name").value + " complete";
      document.getElementById("count").textContent = "Reviews: " + ++reviews;
    });
  </script>
</body>
</html>`;
