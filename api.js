const express = require('express');
const app = express();
const PORT = process.env.PORT || 6967;

// Middleware để đọc JSON body (nếu cần nhận POST request)
app.use(express.json());

// Route cơ bản
app.get('/', (req, res) => {
    res.json({
        status: 'success',
        message: 'Hello from Node.js app running on port 6967!',
        timestamp: new Date()
    });
});

// Route mẫu cho API
app.get('/api/v1/health', (req, res) => {
    res.json({ status: 'OK', uptime: process.uptime() });
});

// Khởi động server
app.listen(PORT, () => {
    console.log(`Server is running at http://localhost:${PORT}`);
});