/**
 * Unit tests for backup.js
 * 100% branch and line coverage
 */

jest.mock('fs');
jest.mock('path');

const fs = require('fs');
const path = require('path');
const { backupDatabase, scheduleBackups, cleanupOldBackups } = require('../utils/backup');

describe('backup', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    console.log = jest.fn();
    console.error = jest.fn();

    // Mock path functions
    path.dirname.mockImplementation((p) => p.substring(0, p.lastIndexOf('/')));
    path.basename.mockImplementation((p) => p.substring(p.lastIndexOf('/') + 1));
    path.join.mockImplementation((...args) => args.join('/'));
  });

  describe('backupDatabase', () => {
    it('should create backup of database file', async () => {
      fs.existsSync.mockReturnValue(true);
      fs.copyFileSync.mockReturnValue(undefined);

      const result = await backupDatabase('/data/app.db');

      expect(result.success).toBe(true);
      expect(result.backupPath).toMatch(/\/data\/app\.db\.backup\./);
      expect(fs.copyFileSync).toHaveBeenCalledWith(
        '/data/app.db',
        expect.stringMatching(/app\.db\.backup\./)
      );
    });

    it('should return error when dbPath is missing', async () => {
      const result = await backupDatabase(null);

      expect(result).toEqual({
        success: false,
        error: 'Database path not found',
      });
      expect(fs.copyFileSync).not.toHaveBeenCalled();
    });

    it('should return error when database file does not exist', async () => {
      fs.existsSync.mockReturnValue(false);

      const result = await backupDatabase('/nonexistent/app.db');

      expect(result).toEqual({
        success: false,
        error: 'Database path not found',
      });
      expect(fs.copyFileSync).not.toHaveBeenCalled();
    });

    it('should return error when copyFileSync fails', async () => {
      fs.existsSync.mockReturnValue(true);
      fs.copyFileSync.mockImplementation(() => {
        throw new Error('Copy failed');
      });

      const result = await backupDatabase('/data/app.db');

      expect(result).toEqual({
        success: false,
        error: 'Copy failed',
      });
      expect(console.error).toHaveBeenCalledWith(
        '[backup] backupDatabase error:',
        'Copy failed'
      );
    });

    it('should generate timestamp in backup path', async () => {
      fs.existsSync.mockReturnValue(true);
      fs.copyFileSync.mockReturnValue(undefined);

      const result = await backupDatabase('/data/app.db');

      // Timestamp should be ISO format with colons and dots replaced by dashes
      expect(result.backupPath).toMatch(/app\.db\.backup\.\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}/);
    });

    it('should call cleanupOldBackups after successful backup', async () => {
      fs.existsSync.mockReturnValue(true);
      fs.copyFileSync.mockReturnValue(undefined);

      const cleanupSpy = jest.spyOn(require('../utils/backup'), 'cleanupOldBackups');
      await backupDatabase('/data/app.db');

      expect(cleanupSpy).toHaveBeenCalledWith('/data/app.db');
      cleanupSpy.mockRestore();
    });

    it('should log successful backup', async () => {
      fs.existsSync.mockReturnValue(true);
      fs.copyFileSync.mockReturnValue(undefined);

      await backupDatabase('/data/app.db');

      expect(console.log).toHaveBeenCalledWith(
        expect.stringMatching(/\[backup\] Created backup:/)
      );
    });

    it('should handle empty dbPath string', async () => {
      const result = await backupDatabase('');

      expect(result).toEqual({
        success: false,
        error: 'Database path not found',
      });
    });
  });

  describe('cleanupOldBackups', () => {
    it('should keep only latest N backups', () => {
      fs.readdirSync.mockReturnValue([
        'app.db.backup.2025-03-25-10-00-00',
        'app.db.backup.2025-03-24-10-00-00',
        'app.db.backup.2025-03-23-10-00-00',
        'app.db.backup.2025-03-22-10-00-00',
        'app.db.backup.2025-03-21-10-00-00',
        'app.db.backup.2025-03-20-10-00-00',
      ]);

      fs.statSync.mockImplementation((filePath) => {
        // Return different times for each file (newest first)
        const times = {
          '/data/app.db.backup.2025-03-25-10-00-00': 1711350000000,
          '/data/app.db.backup.2025-03-24-10-00-00': 1711263600000,
          '/data/app.db.backup.2025-03-23-10-00-00': 1711177200000,
          '/data/app.db.backup.2025-03-22-10-00-00': 1711090800000,
          '/data/app.db.backup.2025-03-21-10-00-00': 1711004400000,
          '/data/app.db.backup.2025-03-20-10-00-00': 1710918000000,
        };
        return { mtimeMs: times[filePath] };
      });

      fs.unlinkSync.mockReturnValue(undefined);

      cleanupOldBackups('/data/app.db', 5);

      // Should delete 1 old backup
      expect(fs.unlinkSync).toHaveBeenCalledTimes(1);
      expect(fs.unlinkSync).toHaveBeenCalledWith('/data/app.db.backup.2025-03-20-10-00-00');
    });

    it('should keep default 5 backups when keepCount not specified', () => {
      fs.readdirSync.mockReturnValue([
        'app.db.backup.2025-03-25-10-00-00',
        'app.db.backup.2025-03-24-10-00-00',
        'app.db.backup.2025-03-23-10-00-00',
        'app.db.backup.2025-03-22-10-00-00',
        'app.db.backup.2025-03-21-10-00-00',
        'app.db.backup.2025-03-20-10-00-00',
        'app.db.backup.2025-03-19-10-00-00',
      ]);

      fs.statSync.mockImplementation(() => ({ mtimeMs: Date.now() }));
      fs.unlinkSync.mockReturnValue(undefined);

      cleanupOldBackups('/data/app.db');

      // Should delete old backups, keeping 5
      expect(fs.unlinkSync).toHaveBeenCalled();
    });

    it('should handle custom keepCount', () => {
      fs.readdirSync.mockReturnValue([
        'app.db.backup.2025-03-25-10-00-00',
        'app.db.backup.2025-03-24-10-00-00',
        'app.db.backup.2025-03-23-10-00-00',
        'app.db.backup.2025-03-22-10-00-00',
        'app.db.backup.2025-03-21-10-00-00',
      ]);

      fs.statSync.mockImplementation(() => ({ mtimeMs: Date.now() }));
      fs.unlinkSync.mockReturnValue(undefined);

      cleanupOldBackups('/data/app.db', 2);

      // Should delete 3 old backups to keep only 2
      expect(fs.unlinkSync).toHaveBeenCalledTimes(3);
    });

    it('should not delete when number of backups equals keepCount', () => {
      fs.readdirSync.mockReturnValue([
        'app.db.backup.2025-03-25-10-00-00',
        'app.db.backup.2025-03-24-10-00-00',
        'app.db.backup.2025-03-23-10-00-00',
      ]);

      fs.statSync.mockImplementation(() => ({ mtimeMs: Date.now() }));
      fs.unlinkSync.mockReturnValue(undefined);

      cleanupOldBackups('/data/app.db', 3);

      expect(fs.unlinkSync).not.toHaveBeenCalled();
    });

    it('should not delete when number of backups is less than keepCount', () => {
      fs.readdirSync.mockReturnValue([
        'app.db.backup.2025-03-25-10-00-00',
        'app.db.backup.2025-03-24-10-00-00',
      ]);

      fs.statSync.mockImplementation(() => ({ mtimeMs: Date.now() }));
      fs.unlinkSync.mockReturnValue(undefined);

      cleanupOldBackups('/data/app.db', 5);

      expect(fs.unlinkSync).not.toHaveBeenCalled();
    });

    it('should filter only backup files matching pattern', () => {
      fs.readdirSync.mockReturnValue([
        'app.db.backup.2025-03-25-10-00-00',
        'app.db.backup.2025-03-24-10-00-00',
        'app.db',
        'app.db.wal',
        'app.db.shm',
        'other.db.backup.2025-03-25-10-00-00',
      ]);

      fs.statSync.mockImplementation(() => ({ mtimeMs: Date.now() }));
      fs.unlinkSync.mockReturnValue(undefined);

      cleanupOldBackups('/data/app.db', 1);

      // Should only delete 1 of the 2 matching backups
      expect(fs.unlinkSync).toHaveBeenCalledTimes(1);
    });

    it('should handle unlinkSync error', () => {
      fs.readdirSync.mockReturnValue([
        'app.db.backup.2025-03-25-10-00-00',
        'app.db.backup.2025-03-24-10-00-00',
      ]);

      fs.statSync.mockImplementation(() => ({ mtimeMs: Date.now() }));
      fs.unlinkSync.mockImplementation(() => {
        throw new Error('Permission denied');
      });

      cleanupOldBackups('/data/app.db', 1);

      expect(console.error).toHaveBeenCalledWith(
        expect.stringMatching(/\[backup\] Failed to delete/),
        expect.anything()
      );
    });

    it('should handle readdirSync error', () => {
      fs.readdirSync.mockImplementation(() => {
        throw new Error('Directory not found');
      });

      cleanupOldBackups('/data/app.db');

      expect(console.error).toHaveBeenCalledWith(
        '[backup] cleanupOldBackups error:',
        'Directory not found'
      );
    });

    it('should handle statSync error', () => {
      fs.readdirSync.mockReturnValue([
        'app.db.backup.2025-03-25-10-00-00',
      ]);

      fs.statSync.mockImplementation(() => {
        throw new Error('Stat failed');
      });

      cleanupOldBackups('/data/app.db');

      expect(console.error).toHaveBeenCalledWith(
        '[backup] cleanupOldBackups error:',
        'Stat failed'
      );
    });

    it('should log deleted backups', () => {
      fs.readdirSync.mockReturnValue([
        'app.db.backup.2025-03-25-10-00-00',
        'app.db.backup.2025-03-24-10-00-00',
      ]);

      fs.statSync.mockImplementation(() => ({ mtimeMs: Date.now() }));
      fs.unlinkSync.mockReturnValue(undefined);

      cleanupOldBackups('/data/app.db', 1);

      expect(console.log).toHaveBeenCalledWith(
        expect.stringMatching(/\[backup\] Deleted old backup:/)
      );
    });

    it('should sort backups by modification time, newest first', () => {
      fs.readdirSync.mockReturnValue([
        'app.db.backup.2025-03-20-10-00-00', // oldest
        'app.db.backup.2025-03-25-10-00-00', // newest
        'app.db.backup.2025-03-22-10-00-00', // middle
      ]);

      const times = {
        '/data/app.db.backup.2025-03-20-10-00-00': 1,
        '/data/app.db.backup.2025-03-25-10-00-00': 3,
        '/data/app.db.backup.2025-03-22-10-00-00': 2,
      };

      fs.statSync.mockImplementation((filePath) => ({ mtimeMs: times[filePath] }));
      fs.unlinkSync.mockReturnValue(undefined);

      cleanupOldBackups('/data/app.db', 1);

      // Should delete the oldest two backups
      expect(fs.unlinkSync).toHaveBeenCalledWith('/data/app.db.backup.2025-03-22-10-00-00');
      expect(fs.unlinkSync).toHaveBeenCalledWith('/data/app.db.backup.2025-03-20-10-00-00');
    });
  });

  describe('scheduleBackups', () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('should create initial backup immediately', () => {
      fs.existsSync.mockReturnValue(true);
      fs.copyFileSync.mockReturnValue(undefined);

      scheduleBackups('/data/app.db');

      expect(fs.copyFileSync).toHaveBeenCalled();
    });

    it('should schedule recurring backups', () => {
      fs.existsSync.mockReturnValue(true);
      fs.copyFileSync.mockReturnValue(undefined);

      scheduleBackups('/data/app.db', 1); // 1 hour

      jest.advanceTimersByTime(60 * 60 * 1000);

      expect(fs.copyFileSync).toHaveBeenCalledTimes(2); // initial + scheduled
    });

    it('should use default interval of 24 hours', () => {
      fs.existsSync.mockReturnValue(true);
      fs.copyFileSync.mockReturnValue(undefined);

      scheduleBackups('/data/app.db');

      expect(console.log).toHaveBeenCalledWith(
        '[backup] Backups scheduled every 24 hours'
      );
    });

    it('should use custom interval when specified', () => {
      fs.existsSync.mockReturnValue(true);
      fs.copyFileSync.mockReturnValue(undefined);

      scheduleBackups('/data/app.db', 12);

      expect(console.log).toHaveBeenCalledWith(
        '[backup] Backups scheduled every 12 hours'
      );
    });

    it('should return interval handle', () => {
      fs.existsSync.mockReturnValue(true);
      fs.copyFileSync.mockReturnValue(undefined);

      const handle = scheduleBackups('/data/app.db');

      expect(handle).toBeDefined();
      expect(typeof handle).toBe('number'); // setInterval returns a number
    });

    it('should allow clearing scheduled backups', () => {
      fs.existsSync.mockReturnValue(true);
      fs.copyFileSync.mockReturnValue(undefined);

      const handle = scheduleBackups('/data/app.db', 1);
      clearInterval(handle);

      jest.advanceTimersByTime(2 * 60 * 60 * 1000);

      expect(fs.copyFileSync).toHaveBeenCalledTimes(1); // only initial
    });

    it('should handle backup failure in initial backup', () => {
      fs.existsSync.mockReturnValue(true);
      fs.copyFileSync.mockImplementation(() => {
        throw new Error('Backup failed');
      });

      scheduleBackups('/data/app.db');

      expect(console.error).toHaveBeenCalledWith(
        '[backup] Initial backup failed:',
        expect.anything()
      );
    });

    it('should handle backup failure in scheduled backup', () => {
      fs.existsSync.mockReturnValue(true);
      let callCount = 0;
      fs.copyFileSync.mockImplementation(() => {
        callCount++;
        if (callCount > 1) {
          throw new Error('Backup failed');
        }
      });

      scheduleBackups('/data/app.db', 1); // 1 hour

      jest.advanceTimersByTime(60 * 60 * 1000);

      expect(console.error).toHaveBeenCalledWith(
        '[backup] Scheduled backup failed:',
        expect.anything()
      );
    });

    it('should continue scheduled backups after failure', () => {
      fs.existsSync.mockReturnValue(true);
      let callCount = 0;
      fs.copyFileSync.mockImplementation(() => {
        callCount++;
        if (callCount === 2) {
          throw new Error('Backup failed');
        }
      });

      scheduleBackups('/data/app.db', 1); // 1 hour

      jest.advanceTimersByTime(2 * 60 * 60 * 1000);

      // Should be called 3 times: initial + 2 scheduled (one fails but continues)
      expect(fs.copyFileSync).toHaveBeenCalledTimes(3);
    });

    it('should log scheduled message', () => {
      fs.existsSync.mockReturnValue(true);
      fs.copyFileSync.mockReturnValue(undefined);

      scheduleBackups('/data/app.db', 6);

      expect(console.log).toHaveBeenCalledWith(
        '[backup] Backups scheduled every 6 hours'
      );
    });

    it('should handle multiple backup intervals', () => {
      fs.existsSync.mockReturnValue(true);
      fs.copyFileSync.mockReturnValue(undefined);

      const handle1 = scheduleBackups('/data/app.db', 1);
      const handle2 = scheduleBackups('/data/app2.db', 2);

      jest.advanceTimersByTime(2 * 60 * 60 * 1000);

      clearInterval(handle1);
      clearInterval(handle2);

      // First db: initial + 2 scheduled
      // Second db: initial + 1 scheduled
      expect(fs.copyFileSync).toHaveBeenCalledTimes(5);
    });
  });
});
