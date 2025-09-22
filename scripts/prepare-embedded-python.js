const fs = require('fs');
const path = require('path');
const https = require('https');
const { execSync } = require('child_process');
const { createWriteStream } = require('fs');
const { pipeline } = require('stream');
const { promisify } = require('util');
const tar = require('tar');

const pipelineAsync = promisify(pipeline);

class EmbeddedPythonBuilder {
  constructor() {
    this.pythonVersion = '3.11.6';
    this.buildDate = '20231002';
    this.pythonDir = path.join(__dirname, '..', 'python');
  }

  async build() {
    console.log('🐍 开始准备嵌入式Python环境...');
    
    try {
      // 1. 清理现有Python目录
      await this.cleanup();
      
      // 2. 下载Python运行时
      await this.downloadPythonRuntime();
      
      // 3. 安装Python依赖
      await this.installDependencies();
      
      // 4. 清理不必要文件
      await this.cleanupUnnecessaryFiles();
      
      console.log('✅ 嵌入式Python环境准备完成！');
      
    } catch (error) {
      console.error('❌ 准备Python环境失败:', error.message);
      process.exit(1);
    }
  }

  async cleanup() {
    if (fs.existsSync(this.pythonDir)) {
      console.log('🧹 清理现有Python目录...');
      fs.rmSync(this.pythonDir, { recursive: true, force: true });
    }
    fs.mkdirSync(this.pythonDir, { recursive: true });
  }

  async downloadPythonRuntime() {
    const arch = process.arch === 'arm64' ? 'aarch64' : 'x86_64';
    const filename = `cpython-${this.pythonVersion}+${this.buildDate}-${arch}-apple-darwin-install_only.tar.gz`;
    const url = `https://github.com/indygreg/python-build-standalone/releases/download/${this.buildDate}/${filename}`;
    const tarPath = path.join(this.pythonDir, 'python.tar.gz');

    console.log(`📥 下载Python运行时 (${arch})...`);
    console.log(`URL: ${url}`);

    await this.downloadFile(url, tarPath);
    
    console.log('📦 解压Python运行时...');
    await tar.extract({
      file: tarPath,
      cwd: this.pythonDir,
      strip: 1
    });

    // 删除压缩包
    fs.unlinkSync(tarPath);
    
    console.log('✅ Python运行时下载完成');
  }

  async downloadFile(url, outputPath) {
    return new Promise((resolve, reject) => {
      const file = createWriteStream(outputPath);
      
      https.get(url, (response) => {
        if (response.statusCode === 302 || response.statusCode === 301) {
          // 处理重定向
          return this.downloadFile(response.headers.location, outputPath)
            .then(resolve)
            .catch(reject);
        }
        
        if (response.statusCode !== 200) {
          reject(new Error(`下载失败: HTTP ${response.statusCode}`));
          return;
        }

        const totalSize = parseInt(response.headers['content-length'], 10);
        let downloadedSize = 0;

        response.on('data', (chunk) => {
          downloadedSize += chunk.length;
          if (totalSize) {
            const progress = Math.round((downloadedSize / totalSize) * 100);
            process.stdout.write(`\r进度: ${progress}% (${Math.round(downloadedSize / 1024 / 1024)}MB / ${Math.round(totalSize / 1024 / 1024)}MB)`);
          }
        });

        response.pipe(file);

        file.on('finish', () => {
          file.close();
          console.log('\n✅ 下载完成');
          resolve();
        });

        file.on('error', (error) => {
          fs.unlink(outputPath, () => {}); // 错误时清理
          reject(error);
        });

      }).on('error', (error) => {
        reject(error);
      });
    });
  }

  async installDependencies() {
    const pythonPath = path.join(this.pythonDir, 'bin', 'python3.11');
    const sitePackagesPath = path.join(this.pythonDir, 'lib', 'python3.11', 'site-packages');

    console.log('📦 安装Python依赖...');

    // 确保pip是最新的
    console.log('⬆️ 升级pip...');
    try {
      execSync(`"${pythonPath}" -m pip install --upgrade pip`, {
        stdio: 'inherit',
        env: {
          ...process.env,
          PYTHONHOME: this.pythonDir,
          PYTHONPATH: sitePackagesPath,
          PYTHONDONTWRITEBYTECODE: '1'
        }
      });
    } catch (error) {
      console.warn('⚠️ pip升级失败，继续安装依赖...');
    }

    // 定义依赖列表 - 确保numpy等核心依赖被正确安装
    const dependencies = [
      'numpy<2',  // 先安装numpy，作为其他库的基础依赖
      'torch==2.0.1',
      'torchaudio==2.0.2',
      'torchvision==0.15.2',
      'librosa>=0.11.0',
      'funasr>=1.2.7'
    ];

    // 逐个安装依赖（包含所有子依赖）
    for (const dep of dependencies) {
      console.log(`📦 安装 ${dep}...`);
      try {
        // 构建完整的环境变量
        const installEnv = {
          ...process.env,
          PYTHONHOME: this.pythonDir,
          PYTHONPATH: sitePackagesPath,
          PYTHONDONTWRITEBYTECODE: '1',
          PYTHONIOENCODING: 'utf-8',
          PYTHONUNBUFFERED: '1',
          PIP_NO_CACHE_DIR: '1',
          // 确保库路径正确
          LD_LIBRARY_PATH: path.join(this.pythonDir, 'lib'),
          DYLD_LIBRARY_PATH: path.join(this.pythonDir, 'lib'), // macOS
        };
        
        // 清除可能干扰的环境变量
        delete installEnv.PYTHONUSERBASE;
        delete installEnv.PYTHONSTARTUP;
        delete installEnv.VIRTUAL_ENV;
        
        execSync(`"${pythonPath}" -m pip install --target "${sitePackagesPath}" --no-deps --force-reinstall "${dep}"`, {
          stdio: 'inherit',
          env: installEnv
        });
        
        // 安装依赖的依赖
        execSync(`"${pythonPath}" -m pip install --target "${sitePackagesPath}" --only-binary=all "${dep}"`, {
          stdio: 'inherit',
          env: installEnv
        });
        
        console.log(`✅ ${dep} 安装完成`);
      } catch (error) {
        console.error(`❌ ${dep} 安装失败:`, error.message);
        // 尝试不使用 --no-deps 重新安装
        try {
          console.log(`🔄 重试安装 ${dep} (包含依赖)...`);
          const installEnv = {
            ...process.env,
            PYTHONHOME: this.pythonDir,
            PYTHONPATH: sitePackagesPath,
            PYTHONDONTWRITEBYTECODE: '1',
            PYTHONIOENCODING: 'utf-8',
            PYTHONUNBUFFERED: '1',
            PIP_NO_CACHE_DIR: '1',
            LD_LIBRARY_PATH: path.join(this.pythonDir, 'lib'),
            DYLD_LIBRARY_PATH: path.join(this.pythonDir, 'lib'),
          };
          
          delete installEnv.PYTHONUSERBASE;
          delete installEnv.PYTHONSTARTUP;
          delete installEnv.VIRTUAL_ENV;
          
          execSync(`"${pythonPath}" -m pip install --target "${sitePackagesPath}" --force-reinstall "${dep}"`, {
            stdio: 'inherit',
            env: installEnv
          });
          console.log(`✅ ${dep} 重试安装成功`);
        } catch (retryError) {
          console.error(`❌ ${dep} 重试安装也失败:`, retryError.message);
          // 继续安装其他依赖
        }
      }
    }

    // 验证关键依赖
    await this.verifyDependencies(pythonPath);
  }

  async verifyDependencies(pythonPath) {
    console.log('🔍 验证依赖安装...');
    
    const criticalDeps = ['numpy', 'torch', 'librosa', 'funasr'];
    const sitePackagesPath = path.join(this.pythonDir, 'lib', 'python3.11', 'site-packages');
    
    for (const dep of criticalDeps) {
      try {
        // 构建完整的环境变量
        const verifyEnv = {
          ...process.env,
          PYTHONHOME: this.pythonDir,
          PYTHONPATH: sitePackagesPath,
          PYTHONDONTWRITEBYTECODE: '1',
          PYTHONIOENCODING: 'utf-8',
          PYTHONUNBUFFERED: '1',
          // 确保库路径正确
          LD_LIBRARY_PATH: path.join(this.pythonDir, 'lib'),
          DYLD_LIBRARY_PATH: path.join(this.pythonDir, 'lib'), // macOS
        };
        
        // 清除可能干扰的环境变量
        delete verifyEnv.PYTHONUSERBASE;
        delete verifyEnv.PYTHONSTARTUP;
        delete verifyEnv.VIRTUAL_ENV;
        
        const result = execSync(`"${pythonPath}" -c "import ${dep}; print('${dep} OK')"`, {
          stdio: 'pipe',
          env: verifyEnv
        });
        
        console.log(`✅ ${dep} 验证通过: ${result.toString().trim()}`);
      } catch (error) {
        console.error(`❌ ${dep} 验证失败:`, error.message);
        console.error('错误输出:', error.stderr?.toString() || '无');
        throw new Error(`关键依赖 ${dep} 安装失败: ${error.message}`);
      }
    }
  }

  async cleanupUnnecessaryFiles() {
    console.log('🧹 清理不必要文件...');
    
    const unnecessaryPaths = [
      path.join(this.pythonDir, 'share', 'doc'),
      path.join(this.pythonDir, 'share', 'man'),
      path.join(this.pythonDir, 'include'),
      path.join(this.pythonDir, 'lib', 'pkgconfig'),
      path.join(this.pythonDir, 'lib', 'python3.11', 'test'),
      path.join(this.pythonDir, 'lib', 'python3.11', 'distutils'),
    ];

    for (const unnecessaryPath of unnecessaryPaths) {
      if (fs.existsSync(unnecessaryPath)) {
        try {
          fs.rmSync(unnecessaryPath, { recursive: true, force: true });
          console.log(`🗑️ 删除: ${path.relative(this.pythonDir, unnecessaryPath)}`);
        } catch (error) {
          console.warn(`⚠️ 无法删除: ${unnecessaryPath}`);
        }
      }
    }

    // 删除.pyc文件
    this.deletePycFiles(this.pythonDir);
    
    console.log('✅ 清理完成');
  }

  deletePycFiles(dir) {
    const items = fs.readdirSync(dir);
    
    for (const item of items) {
      const fullPath = path.join(dir, item);
      const stat = fs.statSync(fullPath);
      
      if (stat.isDirectory()) {
        if (item === '__pycache__') {
          fs.rmSync(fullPath, { recursive: true, force: true });
        } else {
          this.deletePycFiles(fullPath);
        }
      } else if (item.endsWith('.pyc')) {
        fs.unlinkSync(fullPath);
      }
    }
  }

  async getEmbeddedPythonInfo() {
    const pythonPath = path.join(this.pythonDir, 'bin', 'python3.11');
    
    if (!fs.existsSync(pythonPath)) {
      return null;
    }

    try {
      const version = execSync(`"${pythonPath}" --version`, { 
        encoding: 'utf8',
        env: {
          ...process.env,
          PYTHONHOME: this.pythonDir,
          PYTHONDONTWRITEBYTECODE: '1'
        }
      }).trim();
      
      const sizeInfo = this.getDirectorySize(this.pythonDir);
      
      return {
        version,
        path: pythonPath,
        size: sizeInfo,
        ready: true
      };
    } catch (error) {
      return {
        ready: false,
        error: error.message
      };
    }
  }

  getDirectorySize(dirPath) {
    let totalSize = 0;
    let fileCount = 0;

    const calculateSize = (dir) => {
      const items = fs.readdirSync(dir);
      
      for (const item of items) {
        const fullPath = path.join(dir, item);
        const stat = fs.statSync(fullPath);
        
        if (stat.isDirectory()) {
          calculateSize(fullPath);
        } else {
          totalSize += stat.size;
          fileCount++;
        }
      }
    };

    calculateSize(dirPath);
    
    return {
      bytes: totalSize,
      mb: Math.round(totalSize / 1024 / 1024),
      files: fileCount
    };
  }
}

// 主函数
async function main() {
  const builder = new EmbeddedPythonBuilder();
  
  if (process.argv.includes('--info')) {
    const info = await builder.getEmbeddedPythonInfo();
    console.log('嵌入式Python信息:', JSON.stringify(info, null, 2));
    return;
  }
  
  await builder.build();
  
  // 显示最终信息
  const info = await builder.getEmbeddedPythonInfo();
  console.log('\n📊 嵌入式Python环境信息:');
  console.log(`版本: ${info.version}`);
  console.log(`路径: ${info.path}`);
  console.log(`大小: ${info.size.mb}MB (${info.size.files} 个文件)`);
}

if (require.main === module) {
  main().catch(console.error);
}

module.exports = EmbeddedPythonBuilder;