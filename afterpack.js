// afterpack.js - создайте этот файл в корне проекта
const fs = require('fs');
const path = require('path');

exports.default = async function(context) {
    console.log('After pack hook running...');
    
    const appOutDir = context.appOutDir;
    const platform = context.packager.platform.name;
    
    if (platform === 'windows') {
        const sourcePath = path.join(__dirname, 'dist-electron', 'native-addon.node');
        const targetPath = path.join(appOutDir, 'resources', 'app', 'dist-electron', 'native-addon.node');
        
        console.log(`Copying native-addon.node...`);
        console.log(`From: ${sourcePath}`);
        console.log(`To: ${targetPath}`);
        
        // Также проверим если файл уже скопирован в resources через extraResources
        const extraResourcePath = path.join(appOutDir, 'resources', 'native-addon.node');
        
        if (fs.existsSync(sourcePath)) {
            // Создаем директорию если её нет
            const targetDir = path.dirname(targetPath);
            if (!fs.existsSync(targetDir)) {
                fs.mkdirSync(targetDir, { recursive: true });
            }
            
            // Копируем файл
            fs.copyFileSync(sourcePath, targetPath);
            console.log('✓ native-addon.node copied successfully to app/dist-electron');
            
            // Проверяем размер
            const stats = fs.statSync(targetPath);
            console.log(`File size: ${stats.size} bytes`);
            
            // Удаляем лишнюю копию из resources если она есть
            if (fs.existsSync(extraResourcePath)) {
                console.log('Removing duplicate from resources root...');
                fs.unlinkSync(extraResourcePath);
            }
        } else if (fs.existsSync(extraResourcePath)) {
            // Если файл есть в resources (от extraResources), переместим его
            console.log('Found native-addon.node in resources, moving to correct location...');
            
            // Создаем директорию если её нет
            const targetDir = path.dirname(targetPath);
            if (!fs.existsSync(targetDir)) {
                fs.mkdirSync(targetDir, { recursive: true });
            }
            
            // Перемещаем файл
            fs.renameSync(extraResourcePath, targetPath);
            console.log('✓ native-addon.node moved to app/dist-electron');
        } else {
            console.log(`⚠️  native-addon.node not found (optional for Virtual Cable mode): ${sourcePath}`);
        }
    }
};