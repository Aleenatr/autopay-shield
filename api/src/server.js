import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import connectDB from "./config/database.js";
import { connectRedis } from "./config/redis.js";
import adminRoutes from "./routes/admin.js";
import publicRoutes from "./routes/public.js";
import { startCronJob, runImmediateReprocessing } from "./services/cronScheduler.js";
import requireApiKey from "./middleware/requireApiKey.js";
 
dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;
 
app.use(cors({
   origin: ['http://localhost:5173', 'http://localhost:5174'],
   methods: ['GET', 'POST', 'PUT', 'DELETE'],
   credentials: true
}));
 
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
 
// Every /api/admin route - including /reprocess-now below - needs the API key.
app.use('/api/admin', requireApiKey);
app.use('/api/admin', adminRoutes);
app.use('/api/public', publicRoutes);
 
app.get("/", (req, res) => {
   res.json({
      status: "running",
      message: "Autopay Shield API v2.0",
      endpoints: {
         admin: {
            ingest: "POST /api/admin/ingest",
            merchants: "GET /api/admin/merchants",
            merchantDetails: "GET /api/admin/merchants/:merchantId",
            stats: "GET /api/admin/stats"
         },
         public: {
            merchants: "GET /api/public/merchants",
            merchantDetails: "GET /api/public/merchants/:merchantId",
            search: "GET /api/public/search?q=name",
            stats: "GET /api/public/stats"
         }
      }
   });
});
 
app.post("/api/admin/reprocess-now", async (req, res) => {
   try {
      const result = await runImmediateReprocessing();
      res.json({
         success: true,
         message: "Reprocessing completed",
         result
      });
   } catch (error) {
      res.status(500).json({
         success: false,
         message: "Reprocessing failed",
         error: error.message
      });
   }
});
 
async function startServer() {
   try { 
      await connectDB();
      await connectRedis();
       
      app.listen(PORT, () => {
         console.log(`Server running on port ${PORT}`);
         console.log(`Admin API: http://localhost:${PORT}/api/admin`);
         console.log(`Public API: http://localhost:${PORT}/api/public`);
      });
      const cronSchedule = process.env.CRON_SCHEDULE || '0 */6 * * *';
      startCronJob(cronSchedule);
      
   } catch (error) {
      console.error("Server startup failed:", error);
      process.exit(1);
   }
}

startServer();
