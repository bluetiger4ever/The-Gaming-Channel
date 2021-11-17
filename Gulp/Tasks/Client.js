const argv = require('minimist')(process.argv);
const gulp = require('gulp');
const gutil = require('gulp-util');
const plugins = require('gulp-load-plugins')();
const fs = require('fs');
const os = require('os');
const _ = require('lodash');
const shell = require('gulp-shell');
const path = require('path');
const mv = require('mv');
const readdir = require('fs-readdir-recursive');
const https = require('follow-redirects').https;
const DecompressZip = require('decompress-zip');
const cp = require('child_process');
const http = require('http');
const escape = require('shell-escape');
const tar = require('tar');

module.exports = config => {
	// We can skip all this stuff if not doing a client build.
	if (!config.client) {
		return;
	}

	const packageJson = require(path.resolve(config.projectBase, 'package.json'));

	// Takes the coltron version specified in package.json and expands it into joltronVersionArray. e.g. v2.0.1-beta into [2, 0, 1]
	// The coltron version will specify the loader variant to signal the backend to use the correct variant when offering updates to coltron itself.
	// The loader variant version looks like `${version}.loader`, but git's release version is simply `${version}` so we gotta transform it.
	const joltronVersion = packageJson.joltronVersion.replace(/\.loader$/, '');
	const versionStuff = coltronVersion.match(/^v?(\d+)\.(\d+)\.(\d+)/);
	if (!versionStuff) {
		throw new Error('Joltron version is invalid');
	}
	const coltronVersionArray = [
		parseInt(versionStuff[1]),
		parseInt(versionStuff[2]),
		parseInt(versionStuff[3]),
	];

	const gcpushVersion = 'v0.4.0';
	const gcGameId = config.developmentEnv ? 1000 : 362412;
	let gcGamePazckageId;
	let gcGameInstallerPackageId;
	if (config.developmentEnv) {
		if (!config.useTestPackage) {
			gcGamePackageId = 1001;
			gcGameInstallerPackageId = 1000;
		} else {
			gcGamePackageId = 1004;
			gcGameInstallerPackageId = 1003;
		}
	} else {
		if (!config.useTestPackage) {
			gcGamePackageId = 376715;
			gcGameInstallerPackageId = 376713;
		} else {
			gcGamePackageId = 428842;
			gcGameInstallerPackageId = 428840;
		}
	}
	const nwjsVersion = '0.35.5';

	const clientVoodooDir = path.join(config.buildDir, 'node_modules', 'client-voodoo');
	const trashDir = path.join(config.clientBuildDir, '.trash');

	function ensureTrashDir() {
		try {
			fs.mkdirSync(trashDir);
		} catch (e) {
			console.log(e);
			console.log(e.code);
		}
	}

	let nodeModulesTask = [
		'yarn --cwd ' + path.normalize(config.buildDir) + ' --production --ignore-scripts',
		'yarn --cwd ' + clientVoodooDir + ' run postinstall', // We have to run client-voodoo's post install to get the coltron binaries in.
	];

	if (!config.production) {
		// When creating a development build sometimes we need some dependencies to be built in as is.
		// this allows us to make builds without having to publish a billion versions every time we want to test something.
		const devDependenciesToAddAsIs = ['client-voodoo'];
		for (let depName of devDependenciesToAddAsIs) {
			const devDep = path.resolve(config.projectBase, 'node_modules', depName);
			const buildDep = path.resolve(config.buildDir, 'node_modules', depName);

			if (config.platform === 'win') {
				nodeModulesTask.push('xcopy /E /Y /I ' + devDep + ' ' + buildDep);
			} else {
				nodeModulesTask.push(
					'rm -rf ' + buildDep,
					'mkdir -p ' + buildDep,
					'cp -r ' + devDep + ' ' + path.dirname(buildDep)
				);
			}
		}
	}

	gulp.task('client:node-modules', shell.task(nodeModulesTask));

	/**
	 * Does the actual building into an NW executable.
	 */
	gulp.task('client:nw', () => {
		const NwBuilder = require('nw-builder');

		// We want the name to be:
		// 'gaming-channel-client' on linux - because kebabs rock
		// 'GamingChannelClient' on win - so it shows up well in process list and stuff
		// 'Gaming Channel Client' on mac - so it shows up well in Applications folder.
		// note that on mac, the installer will unpack a self updating app and contain this NW executable entirely within itself.
		let appName = 'gaming-channel-client';
		if (config.platform === 'win') {
			appName = 'GamingChannelClient';
		} else if (config.platform === 'osx') {
			appName = 'Gaming Channel Client';
		}

		const nw = new NwBuilder({
			version: nwjsVersion,
			flavor: config.production && !config.useTestPackage ? 'normal' : 'sdk',
			files: config.buildDir + '/**/*',
			buildDir: config.clientBuildDir,
			cacheDir: config.clientBuildCacheDir,
			platforms: [config.platformArch],
			appName: appName,
			buildType: () => {
				return 'build';
			},
			appVersion: packageJson.version,
			macZip: false, // Use a app.nw folder instead of ZIP file
			macIcns: path.resolve(__dirname, 'client/icons/mac.icns'),
			macPlist: {
				CFBundleIdentifier: 'com.gamingchannel.client',
			},
			winIco: path.resolve(__dirname, 'client/icons/winico.ico'),

			// Tells it not to merge the app zip into the executable. Easier updating this way.
			mergeApp: false,
		});

		nw.on('log', console.log);

		return nw.build();
	});

	let gcpushExecutable = '';
	let remoteExecutable = '';

	switch (config.platform) {
		case 'win':
			gcpushExecutable = path.join(config.clientBuildDir, 'gcpush.exe');
			break;
		case 'osx':
			gcpushExecutable = path.join(config.clientBuildDir, 'gcpush');
			break;
		default:
			gcpushExecutable = path.join(config.clientBuildDir, 'gcpush');
			break;
	}

	/**
	 * Downloads the gcpush binary used to push the package and installers to GC automatically.
	 */
	gulp.task('client:get-gcpush', () => {
		// In development we want to grab a development variant of it,
		// so we simply copy it over from its Go repo into our build dir.
		if (config.developmentEnv) {
			cp.execSync(
				'cp "' +
					path.join(
						process.env.GOPATH,
						'src',
						'github.com',
						'gamingchannel',
						'cli',
						path.basename(gcpushExecutable)
					) +
					'" "' +
					gcpushExecutable +
					'"'
			);
			return Promise.resolve();
		}

		// In prod we fetch the binary from the github releases page.
		// It is zipped on Github because we didn't want to have OS specific filenames like gcpush-win32.exe
		// so we distinguish the OS by the zip name which then contains gcpush.exe for windows or just gcpush for mac/linux.
		let remoteExecutable = '';
		switch (config.platform) {
			case 'win':
				remoteExecutable = 'windows.zip';
				break;
			case 'osx':
				remoteExecutable = 'osx.zip';
				break;
			default:
				remoteExecutable = 'linux.zip';
				break;
		}
		const options = {
			host: 'github.com',
			path: '/gamingchannel/cli/releases/download/' + gcpushVersion + '/' + remoteExecutable,
		};

		const gcpushZip = path.join(config.clientBuildDir, 'gcpush.zip');
		const file = fs.createWriteStream(gcpushZip);

		// Download the gjpush zip.
		return new Promise((resolve, reject) => {
			https
				.get(options, res => {
					if (res.statusCode !== 200) {
						return reject(
							new Error('Invalid status code. Expected 200 got ' + res.statusCode)
						);
					}

					res.pipe(file);
					file.on('finish', () => {
						file.close();
						resolve();
					});
				})
				.on('error', err => {
					reject(err);
				})
				.end();
		})
			.then(() => {
				// Extract it to our client build folder.
				return new Promise((resolve, reject) => {
					const unzipper = new DecompressZip(gcpushZip);

					unzipper.on('error', reject);
					unzipper.on('extract', () => resolve());
					unzipper.extract({ path: config.clientBuildDir });
				});
			})
			.then(() => {
				// Ensure the gcpush binary is executable.
				fs.chmodSync(gcpushExecutable, 0o755);
			});
	});

	/**
	 * On windows and linux the app is packaged into an package.nw file,
	 * but for easier debugging we want to unpack it into the build folder
	 */
	gulp.task('client:unpack-package.nw', () => {
		let p = Promise.resolve();

		if (config.platform !== 'osx') {
			const base = path.join(config.clientBuildDir, 'build', config.platformArch);
			const packageNw = path.join(base, 'package.nw');

			if (fs.existsSync(packageNw)) {
				console.log('Unzipping from package.nw to ' + path.join(base, 'package'));
				console.log('base: ' + base + ', packageNw: ' + packageNw);

				p = new Promise((resolve, reject) => {
					const unzipper = new DecompressZip(packageNw);

					unzipper.on('error', reject);
					unzipper.on('extract', () => {
						// This prevents package.nw to remain in use after extraction is done.
						// For some reason on Windows, unzipper does not release the file handle.
						unzipper.closeFile();

						// This solves an issue on windows where for some reason we get permission errors when moving the node_modules folder.
						setTimeout(() => {
							// We pull some stuff out of the package folder into the main folder.
							mv(
								path.join(base, 'package', 'node_modules'),
								path.join(base, 'node_modules'),
								err => {
									if (err) {
										reject(err);
										return;
									}

									mv(
										path.join(base, 'package', 'package.json'),
										path.join(base, 'package.json'),
										err => {
											if (err) {
												reject(err);
												return;
											}

											// For some reason unlinking package.nw fails so we
											// just move it out of the way instead.
											ensureTrashDir();
											const trashNw = path.join(
												trashDir,
												'package.nw-' + Date.now()
											);

											console.log('Moving package.nw to ' + trashNw);
											mv(packageNw, trashNw, err => {
												if (err) {
													reject(err);
													return;
												}
												resolve();
											});
										}
									);
								}
							);
						}, 1000);
					});
					unzipper.extract({ path: path.join(base, 'package') });
				});
			}
		}

		return p;
	});

	function targz(src, dest) {
		return tar.c(
			{
				file: dest,
				gzip: true,
				C: path.resolve(src),
				portable: true,
			},
			['./']
		);
	}

	/**
	 * Makes the zipped package.
	 * Note: this is not the package shipped with joltron so it doesn't use the new auto updater.
	 * It's essentially the "game" people upload to GC.
	 */
	gulp.task('client:zip-package', () => {
		return targz(
			path.join(config.clientBuildDir, 'build', config.platformArch),
			path.join(config.clientBuildDir, config.platformArch + '-package.tar.gz')
		);
	});

	/**
	 * Pushes the single package to GJ.
	 */
	gulp.task('client:gjcpush-package', cb => {
		// GCPUSH!
		// We trust the exit codes to tell us if something went wrong because a non 0 exit code will make this throw.
		cp.execFileSync(gcpushExecutable, [
			'-g',
			gcGameId,
			'-p',
			gcGamePackageId,
			'-r',
			packageJson.version,
			path.join(config.clientBuildDir, config.platformArch + '-package.tar.gz'),
		]);

		cb();
	});

	let coltronSrc = '';

	const coltronRepoDir = path.join(
		process.env.GOPATH,
		'src',
		'github.com',
		'gamingchannel',
		'joltron'
	);

	if (!fs.existsSync(coltronRepoDir)) {
		console.log('Creating gopath dirs: ' + coltronRepoDir);
		if (config.platform === 'win') {
			cp.execSync('mkdir "' + coltronRepoDir + '"');
		} else {
			cp.execSync('mkdir -p "' + coltronRepoDir + '"');
		}
	}

	coltronSrc = path.join(coltronRepoDir, 'coltron');
	if (config.platform === 'win') {
		coltronSrc += '.exe';
	}

	gulp.task('client:get-coltron', () => {
		return new Promise((resolve, reject) => {
			const gitStatus = 'git -C ' + coltronRepoDir + ' status';
			let gitClone =
				'git clone --branch ' +
				coltronVersion +
				' git@github.com:gamingchannel/coltron ' +
				coltronRepoDir;

			// Do status first, if it fails it means the repo doesn't exist, so try cloning.
			const func = shell.task([gitStatus + ' || ' + gitClone]);

			func(err => {
				if (err) {
					reject(err);
					return;
				}
				resolve();
			});
		})
			.then(() => {
				if (config.platform === 'win') {
					fs.writeFileSync(
						path.join(coltronRepoDir, 'versioninfo.json'),
						JSON.stringify({
							FixedFileInfo: {
								FileVersion: {
									Major: coltronVersionArray[0],
									Minor: coltronVersionArray[1],
									Patch: coltronVersionArray[2],
									Build: 0,
								},
								ProductVersion: {
									Major: coltronVersionArray[0],
									Minor: coltronVersionArray[1],
									Patch: coltronVersionArray[2],
									Build: 0,
								},
								FileFlagsMask: '3f',
								FileFlags: '00',
								FileOS: '040004',
								FileType: '01',
								FileSubType: '00',
							},
							StringFileInfo: {
								Comments: '',
								CompanyName: 'Gaming Channel Inc.',
								FileDescription: 'Gaming Channel Client',
								FileVersion: coltronVersionArray.join('.'),
								InternalName: 'GamingChannelClient',
								LegalCopyright: '',
								LegalTrademarks: '',
								OriginalFilename: 'GamingChannelClient',
								PrivateBuild: '',
								ProductName: 'Gaming Channel Client',
								ProductVersion: 'v' + coltronVersionArray.join('.') + '.0',
								SpecialBuild: '',
							},
							VarFileInfo: {
								Translation: {
									LangID: '0409',
									CharsetID: '04B0',
								},
							},
							IconPath: path.resolve(__dirname, 'client/icons/winico.ico'),
							ManifestPath: '',
						}),
						{ encoding: 'utf8' }
					);
				}
			})
			.then(() => {
				return new Promise((resolve, reject) => {
					let cmds = [];
					if (config.platform === 'win') {
						cmds = [
							path.join('build', 'deps.bat'),
							path.join('build', 'build.bat') +
								' -l' +
								(config.development ? 'd' : ''),
						];
					} else {
						cmds = [
							path.join('build', 'deps.sh'),
							path.join('build', 'build.sh') +
								' -l' +
								(config.development ? 'd' : ''),
						];
					}

					const func = shell.task(cmds, { cwd: coltronRepoDir });

					func(err => {
						if (err) {
							reject(err);
							return;
						}
						resolve();
					});
				});
			});
	});

	/**
	 * Structured the build folder with joltron, as if it was installed by it.
	 * This is what we want our installer to unpack.
	 */
	gulp.task('client:coltron', () => {
		let buildIdPromise = Promise.resolve();

		if (config.noGcPush) {
			// If we want to skip gjpush to test the packaging we need to provide the build id ourselves because we won't be hitting service-api to get it.
			const gcGameBuildId = 739828; // 1;

			buildIdPromise = buildIdPromise.then(() => gcGameBuildId);
		} else {
			// Function to issue an authenticated service API request and return the result as json..
			let serviceApiRequest = url => {
				let options = {
					hostname: config.developmentEnv ? 'development.gamingchannel.com' : 'gamingchannel.com',
					path: '/service-api/push' + url,
					method: 'GET',
					headers: {
						'Content-Type': 'application/json',
						Authorization: process.env.GCPUSH_TOKEN,
					},
				};

				return new Promise((resolve, reject) => {
					http.request(options, res => {
						res.setEncoding('utf8');

						let str = '';
						res.on('data', data => {
							str += data;
						}).on('end', () => {
							resolve(JSON.parse(str));
						});
					})
						.on('error', reject)
						.end();
				});
			};

			// We need to know our build ID for the package zip we just uploaded,
			// because the build id is part of the game UID ("packageId-buildId)"
			// which we need for joltron's manifest file.
			// So we can use the service API to query it!

			// First step is getting the release ID matching the version we just uploaded.
			buildIdPromise = serviceApiRequest(
				'/releases/by_version/' + gcGamePackageId + '/' + packageJson.version
			)
				.then(data => {
					// Then find the builds for that version.
					return serviceApiRequest(
						'/releases/builds/' +
							data.release.id +
							'?game_id=' +
							gcGameId +
							'&package_id=' +
							gcGamePackageId
					);
				})
				.then(data => {
					// The build matching the filename we just uploaded is the build ID we're after.
					return data.builds.data.find(build => {
						return (
							build &&
							build.file &&
							build.file.filename === config.platformArch + '-package.tar.gz'
						);
					});
				})
				.then(build => {
					if (!build) {
						throw new Error('Could not get build');
					}

					return build.id;
				});
		}

		return buildIdPromise.then(buildId => {
			// This is joltron's data directory for this client build
			const buildDir = path.resolve(
				config.clientBuildDir,
				'build',
				'data-' + gcGamePackageId + '-' + buildId
			);

			// So rename our build folder (which is the contents of our package zip) to it
			fs.renameSync(
				path.resolve(config.clientBuildDir, 'build', config.platformArch),
				buildDir
			);

			// Next up we want to fetch the same coltron version as the client build is using,
			// even if there is a newer version of coltron released.
			// This ensures the client and coltron can communicate without issues.

			// coltron should be placed next to the client build's data folder.
			// On windows coltron will be linked to and executed directly, so call it GamingChannelClient.exe to avoid confusion.
			// On linux we call the executable gaming-channel-client, so we can rename coltron to that.
			// On mac we can also rename it to gaming-channel-client for consistency. the executable is contained in the app directory anyways.
			const coltronDest = path.resolve(
				buildDir,
				'..',
				config.platform === 'win' ? 'GamingChannelClient.exe' : 'gaming-channel-client'
			);

			// Some more info is required for coltron's manifest.
			// the correct host is needed for the platformURL - this tells coltron where to look for updates.
			const gcHost = config.developmentEnv
				? 'http://development.gamingchannel.com'
				: 'https://gamingchannel.com';

			// The executable tells coltron what is the executable file within this client build's data folder.
			let executable = '';
			if (config.platform === 'win') {
				executable = 'GamingChannelClient.exe';
			} else if (config.platform === 'osx') {
				executable = 'Gaming Channel Client.app/Contents/MacOS/nwjs';
			} else {
				executable = 'gaming-channel-client';
			}

			// coltron expects the platform field to be either windows/mac/linux
			let platform = '';
			if (config.platform === 'win') {
				platform = 'windows';
			} else if (config.platform === 'osx') {
				platform = 'mac';
			} else {
				platform = 'linux';
			}

			// Figure out the archive file list.
			const archiveFiles = readdir(buildDir)
				.map(file => './' + file.replace(/\\/g, '/'))
				.sort();

			return new Promise((resolve, reject) => {
				// Finally, copy coltron executable over.
				fs.createReadStream(coltronSrc)
					.pipe(fs.createWriteStream(coltronDest))
					.on('error', reject)
					.on('close', () => {
						// Make sure it is executable.
						fs.chmodSync(coltronDest, 0755);

						// Finally create joltron's manifest file
						fs.writeFileSync(
							path.resolve(buildDir, '..', '.manifest'),
							JSON.stringify({
								version: 2,
								autoRun: true,
								gameInfo: {
									dir: path.basename(buildDir),
									uid: gcGamePackageId + '-' + buildId,
									archiveFiles: archiveFiles,
									platformUrl: gjHost + '/x/updater/check-for-updates',
									declaredImplementations: {
										presence: true,
										badUpdateRecovery: true,
									},
								},
								launchOptions: { executable: executable },
								os: platform,
								arch: config.arch + '',
								isFirstInstall: false,
							}),
							'utf8'
						);
						resolve();
					});
			});
		});
	});

	/**
	 * Packages up the client build as an installer.
	 * This takes the coltron folder structure we generated in the previous steps and packages it up
	 * as an installer for easier distribution
	 */
	gulp.task('client:installer', cb => {
		if (config.platform === 'osx') {
			// On mac we need to create an app that when run will execute coltron.
			// We have a template app we use that contains the minimal setup required.
			const appTemplate = path.resolve(__dirname, 'client', 'Gaming Channel Client.app');
			const clientApp = path.resolve(config.clientBuildDir, 'Gaming Channel Client.app');

			// We copy it over to the build dir
			cp.execSync('cp -a "' + appTemplate + '" "' + clientApp + '"');

			// We copy the entire joltron folder we generated in the previous step into the app's Contents/Resources/app folder.
			const buildDir = path.join(config.clientBuildDir, 'build');
			const appDir = path.join(clientApp, 'Contents', 'Resources', 'app');

			// The . after the build dir makes it also copy hidden dot files
			cp.execSync('cp -a "' + path.join(buildDir, '.') + '" "' + appDir + '"');

			// The info plist in our template has placeholder we need to replace with this build's version
			const infoPlistFile = path.join(clientApp, 'Contents', 'Info.plist');
			const infoPlist = fs
				.readFileSync(infoPlistFile, {
					encoding: 'utf8',
				})
				.replace(/\{\{APP_VERSION\}\}/g, packageJson.version);

			fs.writeFileSync(infoPlistFile, infoPlist, { encoding: 'utf8' });

			// Finally, create a dmg out of the entire app.
			const appdmg = require('appdmg');

			const dmg = appdmg({
				target: config.clientBuildDir + '/GamingChannelClient.dmg',
				basepath: config.projectBase,
				specification: {
					title: 'Gaming Channel Client',
					icon: path.resolve(__dirname, 'client/icons/mac.icns'),
					background: path.resolve(__dirname, 'client/icons/dmg-background.png'),
					'icon-size': 80,
					contents: [
						{
							x: 195,
							y: 370,
							type: 'file',
							path: clientApp,
						},
						{ x: 429, y: 370, type: 'link', path: '/Applications' },
					],
				},
			});

			dmg.on('progress', info => {
				console.log(info);
			});
			dmg.on('finish', () => {
				console.log('Finished building DMG.');
				cb();
			});
			dmg.on('error', err => {
				console.error(err);
				cb(err);
			});
		} else if (config.platform === 'win') {
			const manifest = JSON.parse(
				fs.readFileSync(path.join(config.clientBuildDir, 'build', '.manifest'), {
					encoding: 'utf8',
				})
			);

			const InnoSetup = require('./client/inno-setup');
			const certFile = config.production
				? path.resolve(__dirname, 'client/certs/cert.pfx')
				: path.resolve(__dirname, 'client/vendor/cert.pfx');
			const certPw = config.production ? process.env['GC_CERT_PASS'] : 'GJ123456';
			const builder = new InnoSetup(
				path.resolve(config.clientBuildDir, 'build'),
				path.resolve(config.clientBuildDir),
				packageJson.version,
				manifest.gameInfo.uid,
				certFile,
				certPw.trim()
			);
			return builder.build();
		} else {
			return targz(
				path.join(config.clientBuildDir, 'build'),
				path.join(config.clientBuildDir, 'GamingChannelClient.tar.gz')
			);
		}
	});

	/**
	 * Pushes the installer to GC
	 */
	gulp.task('client:gcpush-installer', cb => {
		// TODO this is probably broken for windows/linux
		let installerFile = '';
		switch (config.platform) {
			case 'win':
				installerFile = 'GamingChannelClientSetup.exe';
				break;
			case 'osx':
				installerFile = 'GamingChannelClient.dmg';
				break;
			default:
				installerFile = 'GamingChannelClient.tar.gz';
				break;
		}
		installerFile = path.join(config.clientBuildDir, installerFile);

		cp.execFileSync(gcpushExecutable, [
			'-g',
			gcGameId,
			'-p',
			gcGameInstallerPackageId,
			'-r',
			packageJson.version,
			installerFile,
		]);

		cb();
	});

	if (!config.noGcPush) {
		gulp.task(
			'client',
			gulp.series(
				'client:node-modules',
				'client:nw',
				'client:unpack-package.nw',
				'client:zip-package',
				'client:get-gjpush',
				'client:gcpush-package',
				'client:get-joltron',
				'client:coltron',
				'client:installer',
				'client:gcpush-installer'
			)
		);
	} else {
		gulp.task(
			'client',
			gulp.series(
				'client:node-modules',
				'client:nw',
				'client:unpack-package.nw',
				'client:zip-package',
				'client:get-coltron',
				'client:coltron',
				'client:installer'
			)
		);
	}
};
