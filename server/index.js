require('dotenv').config();
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const session = require('express-session');
const cookieParser = require('cookie-parser');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const passport = require('./config/passport');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "http://localhost:5173",
    methods: ["GET", "POST"],
    credentials: true
  }
});

// Middleware
app.use(helmet());
app.use(cors({
  origin: "http://localhost:5173",
  credentials: true
}));
app.use(morgan('combined'));
app.use(express.json());
app.use(cookieParser());

// Only serve static files in production
if (process.env.NODE_ENV === 'production') {
  app.use(express.static(path.join(__dirname, '../client/dist')));
}

// Session configuration
app.use(session({
  secret: process.env.SESSION_SECRET || 'your-secret-key',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    maxAge: 24 * 60 * 60 * 1000 // 24 hours
  }
}));

// Initialize Passport
app.use(passport.initialize());
app.use(passport.session());

// Database setup
const db = new sqlite3.Database(process.env.DATABASE_PATH || './server/database.sqlite', (err) => {
  if (err) {
    console.error('Error opening database:', err.message);
  } else {
    console.log('Connected to SQLite database');
    initDatabase();
  }
});

// Initialize database tables
function initDatabase() {
  db.serialize(() => {
    // Users table with Google OAuth fields
    db.run(`CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      google_id TEXT UNIQUE,
      username TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      avatar_url TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // Shortcut packages table with author relationship
    db.run(`CREATE TABLE IF NOT EXISTS shortcut_packages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      description TEXT,
      author_id INTEGER NOT NULL,
      author_name TEXT NOT NULL,
      category TEXT,
      shortcuts TEXT NOT NULL,
      downloads INTEGER DEFAULT 0,
      rating REAL DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (author_id) REFERENCES users (id) ON DELETE CASCADE
    )`);

    // Insert sample data only if no packages exist
    db.get('SELECT COUNT(*) as count FROM shortcut_packages', (err, row) => {
      if (err) {
        console.error('Error checking packages:', err.message);
        return;
      }
      
      if (row.count === 0) {
        // Create a sample user first
        db.run('INSERT OR IGNORE INTO users (google_id, username, email, avatar_url) VALUES (?, ?, ?, ?)',
          ['sample_user_1', 'DevMaster', 'devmaster@example.com', null],
          function(err) {
            if (err) {
              console.error('Error creating sample user:', err.message);
              return;
            }
            
            const sampleUserId = this.lastID;
            
            // Insert sample packages
            const samplePackages = [
              {
                name: "VS Code Productivity",
                description: "Essential shortcuts for VS Code development",
                author_id: sampleUserId,
                author_name: "DevMaster",
                category: "Development",
                shortcuts: JSON.stringify([
                  { key: "Ctrl+Shift+P", action: "Command Palette", description: "Open command palette" },
                  { key: "Ctrl+P", action: "Quick Open", description: "Quick file navigation" },
                  { key: "Ctrl+Shift+F", action: "Find in Files", description: "Search across all files" }
                ])
              },
              {
                name: "Photoshop Essentials",
                description: "Must-know shortcuts for Photoshop users",
                author_id: sampleUserId,
                author_name: "DevMaster",
                category: "Design",
                shortcuts: JSON.stringify([
                  { key: "Ctrl+Z", action: "Undo", description: "Undo last action" },
                  { key: "Ctrl+Shift+Z", action: "Redo", description: "Redo last action" },
                  { key: "B", action: "Brush Tool", description: "Select brush tool" }
                ])
              }
            ];

            const insertStmt = db.prepare(`INSERT INTO shortcut_packages 
              (name, description, author_id, author_name, category, shortcuts) VALUES (?, ?, ?, ?, ?, ?)`);
            
            samplePackages.forEach(pkg => {
              insertStmt.run(pkg.name, pkg.description, pkg.author_id, pkg.author_name, pkg.category, pkg.shortcuts);
            });
            insertStmt.finalize();
          }
        );
      }
    });
  });
}

// Import routes
const authRoutes = require('./routes/auth');
const { requireAuth, optionalAuth, checkPackageOwnership } = require('./middleware/auth');

// Routes
app.use('/api/auth', authRoutes);

// API Routes with authentication
app.get('/api/packages', optionalAuth, (req, res) => {
  db.all('SELECT p.*, u.username as author_username, u.avatar_url as author_avatar FROM shortcut_packages p LEFT JOIN users u ON p.author_id = u.id ORDER BY p.created_at DESC', (err, rows) => {
    if (err) {
      res.status(500).json({ error: err.message });
      return;
    }
    res.json(rows);
  });
});

app.get('/api/packages/:id', optionalAuth, (req, res) => {
  db.get('SELECT p.*, u.username as author_username, u.avatar_url as author_avatar FROM shortcut_packages p LEFT JOIN users u ON p.author_id = u.id WHERE p.id = ?', [req.params.id], (err, row) => {
    if (err) {
      res.status(500).json({ error: err.message });
      return;
    }
    if (!row) {
      res.status(404).json({ error: 'Package not found' });
      return;
    }
    res.json(row);
  });
});

app.post('/api/packages', requireAuth, (req, res) => {
  const { name, description, category, shortcuts } = req.body;
  
  if (!name || !shortcuts) {
    res.status(400).json({ error: 'Missing required fields' });
    return;
  }

  const shortcutsJson = JSON.stringify(shortcuts);
  
  db.run(
    'INSERT INTO shortcut_packages (name, description, author_id, author_name, category, shortcuts) VALUES (?, ?, ?, ?, ?, ?)',
    [name, description, req.user.id, req.user.username, category, shortcutsJson],
    function(err) {
      if (err) {
        res.status(500).json({ error: err.message });
        return;
      }
      
      // Get the newly created package
      db.get('SELECT p.*, u.username as author_username, u.avatar_url as author_avatar FROM shortcut_packages p LEFT JOIN users u ON p.author_id = u.id WHERE p.id = ?', [this.lastID], (err, row) => {
        if (err) {
          res.status(500).json({ error: err.message });
          return;
        }
        
        // Emit real-time update to all connected clients
        io.emit('packageAdded', row);
        res.status(201).json(row);
      });
    }
  );
});

app.put('/api/packages/:id', requireAuth, checkPackageOwnership, (req, res) => {
  const { name, description, category, shortcuts } = req.body;
  const shortcutsJson = JSON.stringify(shortcuts);
  
  db.run(
    'UPDATE shortcut_packages SET name = ?, description = ?, category = ?, shortcuts = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
    [name, description, category, shortcutsJson, req.params.id],
    function(err) {
      if (err) {
        res.status(500).json({ error: err.message });
        return;
      }
      
      if (this.changes === 0) {
        res.status(404).json({ error: 'Package not found' });
        return;
      }
      
      // Get the updated package
      db.get('SELECT p.*, u.username as author_username, u.avatar_url as author_avatar FROM shortcut_packages p LEFT JOIN users u ON p.author_id = u.id WHERE p.id = ?', [req.params.id], (err, row) => {
        if (err) {
          res.status(500).json({ error: err.message });
          return;
        }
        
        // Emit real-time update
        io.emit('packageUpdated', row);
        res.json(row);
      });
    }
  );
});

app.delete('/api/packages/:id', requireAuth, checkPackageOwnership, (req, res) => {
  db.run('DELETE FROM shortcut_packages WHERE id = ?', [req.params.id], function(err) {
    if (err) {
      res.status(500).json({ error: err.message });
      return;
    }
    
    if (this.changes === 0) {
      res.status(404).json({ error: 'Package not found' });
      return;
    }
    
    // Emit real-time update
    io.emit('packageDeleted', { id: parseInt(req.params.id) });
    res.json({ message: 'Package deleted successfully' });
  });
});

// Socket.io connection handling with authentication
io.on('connection', (socket) => {
  console.log('User connected:', socket.id);
  
  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.id);
  });
  
  // Join a room for specific package updates
  socket.on('joinPackage', (packageId) => {
    socket.join(`package_${packageId}`);
  });
  
  // Leave a package room
  socket.on('leavePackage', (packageId) => {
    socket.leave(`package_${packageId}`);
  });
});

// Serve React app for all other routes (only in production)
if (process.env.NODE_ENV === 'production') {
  app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, '../client/dist/index.html'));
  });
} else {
  // In development, redirect to the Vite dev server
  app.get('*', (req, res) => {
    res.redirect('http://localhost:5173' + req.url);
  });
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Real-time updates enabled via Socket.io`);
  console.log(`Google OAuth authentication enabled`);
  if (process.env.NODE_ENV !== 'production') {
    console.log(`Development mode: Frontend served by Vite on port 5173`);
  }
}); 