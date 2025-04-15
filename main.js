const { app, BrowserWindow, dialog } = require('electron');
const fs = require('fs');
const path = require('path');
const self = require('./self_rework.js');

// Asynchronous function to validate the token
const validateTokenAsync = async (token) => {
  try {
    isValid = await self.validateToken(token); // Assuming validateToken returns a Promise
    if (!isValid.success) {
      dialog.showErrorBox('Network Error', 'An error occurred while validating the token. Please check your network connection and try again.\nGENERIC_NETWORK_ERROR');
      app.quit();
    }
    return isValid.valid;
  } catch (error) {
    console.error('Error validating token:', error);
    return false;
  }
};

// Function to create the main application window
async function createWindow() {
  const win = new BrowserWindow({
    width: 800,
    height: 600,
    title: 'Discord Packs',
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
  });

  const tokenPath = path.join(__dirname, 'data', 'token.dat');
  if (fs.existsSync(tokenPath)) {
    const tokenData = fs.readFileSync(tokenPath, 'utf-8').trim();
    if (tokenData) {
      const isValid = await validateTokenAsync(tokenData);
      if (isValid) {
        win.loadFile('data/index.html');
      } else {
        fs.writeFileSync(tokenPath, '');
        dialog.showMessageBox({
          title: 'Discord Packs',
          type: 'info',
          message: 'INVALID_TOKEN',
          detail: 'Incorrect token data found in token.dat. Please enter a new valid token.',
          buttons: ['OK'],
        });
        win.loadFile('data/login.html');
      }
    } else {
      win.loadFile('data/login.html'); // Load login page if token.dat is empty
    }
  } else {
    win.loadFile('data/error.html'); // Load error page if token.dat doesn't exist
  }
}

// App lifecycle events
app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});